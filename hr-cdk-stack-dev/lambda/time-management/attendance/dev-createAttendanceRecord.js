// lambda/time-management/attendance/dev-createAttendanceRecord.js

const { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const timeTable = process.env.TIME_MANAGEMENT_TABLE_NAME;
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// --- Helper Functions ---

// Fetches all timestamp logs for a specific YYYY-MM-DD date.
async function getLogsForDate(employeeId, date) {
    const command = new QueryCommand({
        TableName: logTable,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'employeeId = :empId',
        ExpressionAttributeValues: {
            ':pk': { S: `DATE#${date}` },
            ':empId': { S: employeeId }
        }
    });
    const { Items } = await dbClient.send(command);
    if (!Items || Items.length < 2) throw new Error('Insufficient logs: A full workday must have at least a CLOCK_IN and CLOCK_OUT.');
    return Items.map(unmarshall).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Validates for conflicting approved leaves.
async function validateLeaveConflict(employeeId, attendanceDate) {
    const { Items } = await dbClient.send(new QueryCommand({
        TableName: timeTable,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'approvalStatus = :status',
        ExpressionAttributeValues: { ':pk': { S: `EMP#${employeeId}` }, ':status': { S: 'Approved' } }
    }));
    const approvedLeaves = Items ? Items.map(unmarshall) : [];
    const attDate = new Date(attendanceDate);

    const isConflict = approvedLeaves.some(leave => {
        const leaveStart = new Date(leave.startDate);
        const leaveEnd = new Date(leave.endDate);
        return attDate >= leaveStart && attDate <= leaveEnd;
    });

    if (isConflict) throw new Error(`Conflict: An approved leave request exists for this date (${attendanceDate}).`);
}

// Processes logs to calculate hours and extract details.
async function processTimestampLogs(logs) {
    const clockIn = logs.find(l => l.timestampType === 'CLOCK_IN');
    const clockOut = logs.find(l => l.timestampType === 'CLOCK_OUT');
    if (!clockIn || !clockOut) throw new Error('A valid CLOCK_IN and CLOCK_OUT event must exist for the specified date.');

    const totalDurationMs = new Date(clockOut.timestamp) - new Date(clockIn.timestamp);
    if (totalDurationMs > 12 * 60 * 60 * 1000) throw new Error('Work duration cannot exceed 12 hours.');

    let totalBreakMs = 0;
    let currentBreakStart = null;
    for (const log of logs) {
        if (log.timestampType === 'BREAK_START') currentBreakStart = new Date(log.timestamp);
        else if (log.timestampType === 'BREAK_END' && currentBreakStart) {
            const duration = new Date(log.timestamp) - currentBreakStart;
            if (duration > 30 * 60 * 1000) throw new Error(`A break duration cannot exceed the 30 minute maximum.`);
            totalBreakMs += duration;
            currentBreakStart = null;
        }
    }

    const totalWorkMs = totalDurationMs - totalBreakMs;
    const totalHours = totalWorkMs / 3600000;
    const regularHours = Math.min(totalHours, 8);
    const overtimeHours = Math.max(0, totalHours - 8);

    const wbsCode = clockIn.wbsCode;
    let costCenter = null;

    // If a WBS code exists, fetch its details to get the associated cost center.
    if (wbsCode) {
        const { Item: wbsItem } = await dbClient.send(new GetItemCommand({
            TableName: orgTable,
            Key: marshall({ PK: `ORG#WBS#${wbsCode}`, SK: 'METADATA' }),
            ProjectionExpression: 'costCenter'
        }));
        if (wbsItem) {
            costCenter = unmarshall(wbsItem).costCenter;
        } else {
            console.warn(`Could not find details for WBS code '${wbsCode}' to retrieve cost center.`);
        }
    }

    return {
        checkInTime: clockIn.timestamp,
        checkOutTime: clockOut.timestamp,
        totalHours: parseFloat(totalHours.toFixed(2)),
        regularHours: parseFloat(regularHours.toFixed(2)),
        overtimeHours: parseFloat(overtimeHours.toFixed(2)),
        breaks: logs.filter(l => l.timestampType === 'BREAK_START').length,
        wbsCode: wbsCode, // The primary WBS code for the day
        location: clockIn.location, // The primary location for the day
        costCenter: costCenter, // Return the fetched cost center
    };
}

// --- Main Handler ---
exports.handler = async (event) => {
    console.log("Create attendance record request received.");
    try {
        // 1. --- Auth & Input Validation ---
        if (!isAuthorized(event, ['employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }
        
        const body = JSON.parse(event.body);

        // Add the new required fields to the validation check.
        const requiredFields = ['employeeId', 'attendanceDate', 'workMode'];
        const validationResult = validateBody(body, requiredFields);
        if (!validationResult.isValid) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }

        const { employeeId, attendanceDate } = body;
        if (!employeeId || !attendanceDate) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId and attendanceDate are required.' }) };
        }
        
        const requestingEmployeeId = getRequestingUser(event);
        if (requestingEmployeeId !== employeeId) {
            return { statusCode: 403, hheaders: headers, body: JSON.stringify({ message: 'Forbidden: You can only create attendance records for yourself.' }) };
        }

        // 2. --- Pre-check for Duplicate Attendance Record ---
        const { Items: existingAttendance } = await dbClient.send(new QueryCommand({
            TableName: timeTable,
            IndexName: 'GSI4-AttendanceDateIndex',
            KeyConditionExpression: 'GSI4PK = :pk AND GSI4SK = :sk',
            ExpressionAttributeValues: { ':pk': { S: `ATT#${employeeId}` }, ':sk': { S: `DATE#${attendanceDate}` } }
        }));
        if (existingAttendance && existingAttendance.length > 0) {
            throw new Error(`An attendance record for this date (${attendanceDate}) already exists.`);
        }
        
        // 3. --- Run Validations ---
        console.log("Step 3: Validating data and processing logs...");
        await validateLeaveConflict(employeeId, attendanceDate);
        const logsForDay = await getLogsForDate(employeeId, attendanceDate);
        const attendanceDetails = await processTimestampLogs(logsForDay);
        console.log("All validations passed. Details processed:", attendanceDetails);

        // 4. --- Construct & Save Record ---
        console.log("Step 4: Constructing and saving attendance record...");
        const attendanceId = uuidv4();
        const attendanceItem = {
            PK: `TIME#ATT#${attendanceId}`,
            SK: 'METADATA',
            GSI1PK: `EMP#${employeeId}`, // For employee-centric queries
            GSI1SK: `ATTENDANCE#${attendanceDate}`,
            GSI4PK: `ATT#${employeeId}`, // For duplicate checks
            GSI4SK: `DATE#${attendanceDate}`,
            attendanceId,
            formType: 'ATTENDANCE',
            employeeId,
            attendanceDate,
            ...attendanceDetails,
            workMode: body.workMode, // From request body
            projectCode: body.projectCode, // Optional from request body
            taskCategory: body.taskCategory, // Optional from request body
            notes: body.notes ? encrypt(body.notes) : undefined,
            createdBy: requestingEmployeeId,
            createdAt: new Date().toISOString(),
        };

        await dbClient.send(new PutItemCommand({
            TableName: timeTable,
            Item: marshall(attendanceItem, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK)'
        }));

        console.log(`Attendance record ${attendanceId} created successfully.`);
        return { statusCode: 201, headers: headers, body: JSON.stringify({ message: 'Attendance record created successfully.', attendanceId }) };

    } catch (error) {
        console.error('Error creating attendance record:', error);
        return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'Failed to create attendance record.', error: error.message }) };
    }
};