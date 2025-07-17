// lambda/time-management/attendance/dev-getAttendanceRecords.js

const { DynamoDBClient, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getRequestingUser, getUserRole } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.TIME_MANAGEMENT_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    console.log("Request to get attendance records received:", event);
    try {
        const { employeeId } = event.pathParameters;
        const queryParams = event.queryStringParameters || {};
        const { startDate, endDate, limit, nextToken } = queryParams;

        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and parameters...");
        const allowedRoles = ['employee', 'hr_admin', 'manager_admin'];
        if (!isAuthorized(event, allowedRoles)) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        if (!employeeId) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId is required in path.' }) };
        }

        const userRole = getUserRole(event);
        const requestingEmployeeId = getRequestingUser(event);

        if (userRole === 'employee' && requestingEmployeeId !== employeeId) {
            console.warn(`Authorization failure: Employee '${requestingEmployeeId}' attempted to access records for '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only view your own attendance records.' }) };
        }
        console.log(`User '${requestingEmployeeId}' with role '${userRole}' is authorized to view records for '${employeeId}'.`);

        // It's still good practice to ensure the employee you're querying for actually exists.
        console.log("Validating employee existence...");
        const { Item: empItem } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));

        if (!empItem) {
            console.warn(`Attempted to fetch requests for non-existent employee '${employeeId}'.`);
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`Target employee '${employeeId}' confirmed to exist.`);
        
        // 2. --- Build DynamoDB Query using GSI ---
        console.log("Step 2: Building DynamoDB query...");
        const pageLimit = limit ? parseInt(limit, 10) : 100;
        
        // Use the employee-centric GSI1 to fetch all attendance records for the user.
        let keyConditionExpression = 'GSI1PK = :pk AND begins_with(GSI1SK, :sk_prefix)';
        const expressionAttributeValues = {
            ':pk': { S: `EMP#${employeeId}` },
            ':sk_prefix': { S: 'ATTENDANCE#' }
        };

        // Add date range filtering if provided
        if (startDate && endDate) {
            keyConditionExpression = 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end';
            expressionAttributeValues[':start'] = { S: `ATTENDANCE#${startDate}` };
            expressionAttributeValues[':end'] = { S: `ATTENDANCE#${endDate}` };
            delete expressionAttributeValues[':sk_prefix']; // No longer needed
        }

        const command = new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: pageLimit,
            ExclusiveStartKey: nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString('utf8')) : undefined,
            ScanIndexForward: false, // Show most recent attendance first
        });
        
        console.log("Executing query:", JSON.stringify(command.input, null, 2));
        const { Items, LastEvaluatedKey } = await dbClient.send(command);
        
        // 3. --- Process and Format Results ---
        console.log(`Step 3: Processing ${Items?.length || 0} returned items...`);
        const attendanceRecords = (Items || []).map(item => {
            const record = unmarshall(item);
            
            // Decrypt sensitive fields
            if (record.location) record.location = decrypt(record.location);
            if (record.notes) record.notes = decrypt(record.notes);
            
            // Clean up internal keys for the response
            delete record.PK;
            delete record.SK;
            delete record.GSI1PK;
            delete record.GSI1SK;
            delete record.GSI4PK;
            delete record.GSI4SK;
            
            return record;
        });

        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64') : null;
        
        console.log(`Successfully retrieved ${attendanceRecords.length} attendance records.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                employeeId,
                attendanceRecords: attendanceRecords,
                nextToken: newNextToken
            })
        };

    } catch (err) {
        console.error('FATAL ERROR fetching attendance records:', err);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Internal Server Error.', error: err.message })
        };
    }
};