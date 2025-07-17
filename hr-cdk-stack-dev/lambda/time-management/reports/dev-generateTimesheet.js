// lambda/time-management/reports/dev-generateTimesheet.js

const { DynamoDBClient, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized, getRequestingUser, getUserRole } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// --- Helper Functions ---

async function fetchAllLogsForRange(employeeId, startDate, endDate) {
    let allLogs = [];
    let lastEvaluatedKey = undefined;
    const keyConditionExpression = 'PK = :pk AND SK BETWEEN :start AND :end';
    const expressionAttributeValues = {
        ':pk': { S: `EMP#${employeeId}` },
        ':start': { S: startDate },
        ':end': { S: endDate }
    };

    do {
        const command = new QueryCommand({
            TableName: logTable,
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const { Items, LastEvaluatedKey } = await dbClient.send(command);
        if (Items) allLogs.push(...Items.map(unmarshall));
        lastEvaluatedKey = LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return allLogs;
}

function calculatePayrollDetails(logs) {
    const dailyHours = {}; // To store hours per day: { 'YYYY-MM-DD': { total: X, allocations: [] } }

    let currentSegment = null;
    let currentBreak = null;

    logs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (const log of logs) {
        const eventTime = new Date(log.timestamp);
        const eventDate = eventTime.toISOString().split('T')[0];

        if (!dailyHours[eventDate]) {
            dailyHours[eventDate] = { totalHours: 0, allocations: [] };
        }

        if (currentSegment && (log.timestampType === 'WBS_CHANGE' || log.timestampType === 'CLOCK_OUT' || log.timestampType === 'BREAK_START')) {
            currentSegment.endTime = eventTime;
            const duration = (currentSegment.endTime - currentSegment.startTime) / 3600000;
            currentSegment.totalHours = parseFloat(duration.toFixed(3));
            dailyHours[eventDate].allocations.push(currentSegment);
            currentSegment = null;
        }

        if (log.timestampType === 'CLOCK_IN' || log.timestampType === 'WBS_CHANGE' || log.timestampType === 'BREAK_END') {
            currentSegment = {
                startTime: eventTime,
                wbsCode: log.wbsCode,
                endTime: null,
                totalHours: 0
            };
        }

        if (log.timestampType === 'BREAK_START') {
            currentBreak = eventTime;
        } else if (log.timestampType === 'BREAK_END' && currentBreak) {
            const breakDuration = (eventTime - currentBreak) / 3600000;
            dailyHours[eventDate].totalHours -= breakDuration; // Subtract break time from the day's total
            currentBreak = null;
        }
    }

    // Process daily totals and overtime
    Object.values(dailyHours).forEach(day => {
        day.totalHours = day.allocations.reduce((acc, seg) => acc + seg.totalHours, 0);
        day.dailyRegularHours = Math.min(day.totalHours, 8);
        day.dailyOvertimeHours = Math.max(0, day.totalHours - 8);
    });

    // Calculate weekly totals
    const weeklySummary = { totalHours: 0, regularHours: 0, overtimeHours: 0 };
    Object.values(dailyHours).forEach(day => {
        weeklySummary.totalHours += day.totalHours;
        weeklySummary.regularHours += day.dailyRegularHours;
    });

    // Calculate weekly overtime (hours over 40 regular hours)
    const weeklyOvertime = Math.max(0, weeklySummary.regularHours - 40);
    weeklySummary.regularHours -= weeklyOvertime; // Adjust regular hours
    
    // Total OT is the sum of daily OT plus any weekly OT
    const dailyOvertimeTotal = Object.values(dailyHours).reduce((acc, day) => acc + day.dailyOvertimeHours, 0);
    weeklySummary.overtimeHours = weeklyOvertime + dailyOvertimeTotal;

    // Final formatting
    Object.keys(weeklySummary).forEach(k => weeklySummary[k] = parseFloat(weeklySummary[k].toFixed(2)));

    return { dailyBreakdown: dailyHours, weeklySummary };
}

const generateCsv = (data) => {
    const csvRows = ['date,wbsCode,startTime,endTime,totalHours'];
    for (const [date, dayData] of Object.entries(data)) {
        for (const alloc of dayData.allocations) {
            csvRows.push([
                date,
                `"${alloc.wbsCode}"`,
                `"${alloc.startTime.toISOString()}"`,
                `"${alloc.endTime.toISOString()}"`,
                alloc.totalHours.toFixed(2)
            ].join(','));
        }
    }
    return csvRows.join('\n');
};


exports.handler = async (event) => {
    console.log("Timesheet report generation request received:", event);
    try {
        const { employeeId } = event.pathParameters;
        const { startDate, endDate, format = 'json' } = event.queryStringParameters || {};

        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and parameters...");
        if (!isAuthorized(event, ['hr_admin', 'manager_admin', 'employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to generate this report.' }) };
        }
        if (!employeeId || !startDate || !endDate) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId, startDate, and endDate are required query parameters.' }) };
        }

        const userRole = getUserRole(event);
        const requestingEmployeeId = getRequestingUser(event); // This gets custom:empId

        if (userRole === 'employee' && requestingEmployeeId !== employeeId) {
            console.warn(`Authorization failure: Employee '${requestingEmployeeId}' attempted to access timesheet for '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only generate your own timesheet.' }) };
        }
        console.log(`User '${requestingEmployeeId}' with role '${userRole}' is authorized to generate timesheet for '${employeeId}'.`);
        
        // 2. --- Validate Employee Existence and Status ---
        console.log(`Step 2: Validating existence of employee '${employeeId}'...`);
        const { Item: empItem } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));
        
        if (!empItem) {
            console.warn(`Validation failed: Employee with ID '${employeeId}' not found.`);
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`Employee '${employeeId}' validated successfully.`);
        
        // 3. --- Fetch Data ---
        console.log(`Step 3: Fetching logs for employee '${employeeId}' from ${startDate} to ${endDate}.`);
        const allLogs = await fetchAllLogsForRange(employeeId, startDate, endDate);
        if (allLogs.length === 0) {
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'No timestamp logs found for the specified date range.' }) };
        }
        console.log(`Found ${allLogs.length} log entries.`);

        // 4. --- Process Data & Calculate Hours ---
        console.log("Step 4: Calculating payroll details, including daily and weekly overtime...");
        const { dailyBreakdown, weeklySummary } = calculatePayrollDetails(allLogs);
        console.log("Calculation complete. Preparing response.");

        // 5. --- Format and Return Response ---
        if (format.toLowerCase() === 'csv') {
            return {
                statusCode: 200,
                headers: { ...headers, 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="timesheet-allocations-${employeeId}-${startDate}-to-${endDate}.csv"` },
                body: generateCsv(dailyBreakdown)
            };
        }

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                employeeId,
                dateRange: { startDate, endDate },
                weeklySummary: weeklySummary,
                dailyBreakdown: dailyBreakdown
            })
        };

    } catch (err) {
        console.error('FATAL ERROR generating timesheet:', err);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ message: 'Internal Server Error.', error: err.message }) };
    }
};