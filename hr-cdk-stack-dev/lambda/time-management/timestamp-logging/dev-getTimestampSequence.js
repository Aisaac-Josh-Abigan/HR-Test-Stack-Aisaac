// lambda/time-management/timestamp-logging/dev-getTimestampSequence.js

const { DynamoDBClient, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized, getUserRole, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    console.log("Request to get latest timestamp sequence received:", event);
    try {
        const { employeeId } = event.pathParameters;

        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and parameters...");
        const allowedRoles = ['employee', 'hr_admin', 'manager_admin'];
        if (!isAuthorized(event, allowedRoles)) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        
        if (!employeeId) {
            return { statusCode: 400, eaders: headers, body: JSON.stringify({ message: 'employeeId is required in path parameters.' }) };
        }

        const userRole = getUserRole(event);
        const requestingUserId = getRequestingUser(event);

        // An employee can only view their own sequence. Admins can view anyone's.
        if (userRole === 'employee' && requestingUserId !== employeeId) {
            console.warn(`Authorization failure: Employee '${requestingUserId}' attempted to access sequence for '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only view your own sequence data.' }) };
        }
        console.log(`User '${requestingUserId}' with role '${userRole}' is authorized to view sequence for '${employeeId}'.`);

        // 2. --- Validate Employee Existence and Status ---
        console.log("Step 2: Validating employee existence...");
        const empRes = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));

        if (!empRes.Item) {
            console.warn(`Validation failed: Employee with ID '${employeeId}' not found.`);
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`Target employee '${employeeId}' confirmed to exist.`);


        // 3. --- Query for the Latest Timestamp Log ---
        console.log("Step 3: Querying for the latest timestamp log...");
        const logResult = await dbClient.send(new QueryCommand({
            TableName: logTable,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: {
                ':pk': { S: `EMP#${employeeId}` } // Standardize on EMP# for this table
            },
            ScanIndexForward: false, // Descending order to get the latest first
            Limit: 1
        }));
        
        const latestLog = logResult.Items?.[0] ? unmarshall(logResult.Items[0]) : null;

        if (latestLog) {
            console.log(`Found latest log entry with sequence number ${latestLog.sequenceNumber}.`);
        } else {
            console.log("No log entries found for this employee.");
        }

        // 4. --- Format and Return Response ---
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                employeeId,
                latestSequenceNumber: latestLog?.sequenceNumber ?? 0,
                latestTimestamp: latestLog?.timestamp ?? null,
                latestTimestampType: latestLog?.timestampType ?? null,
                hashChain: latestLog?.hashChain ?? null
            })
        };

    } catch (err) {
        console.error('FATAL ERROR in getTimestampSequence handler:', err);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Internal Server Error.', error: err.message }),
        };
    }
};