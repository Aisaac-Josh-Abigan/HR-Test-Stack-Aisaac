// lambda/time-management/timestamp-logging/dev-getTimestampHistory.js

const { DynamoDBClient, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getRequestingUser, getUserRole } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    console.log("Request to get timestamp history received:", event);
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
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId is required in path parameters.' }) };
        }

        const userRole = getUserRole(event);
        const requestingUserId = getRequestingUser(event);

        // An employee can only view their own history. Admins can view anyone's.
        if (userRole === 'employee' && requestingUserId !== employeeId) {
            console.warn(`Authorization failure: Employee '${requestingUserId}' attempted to access history for '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only view your own timestamp history.' }) };
        }
        console.log(`User '${requestingUserId}' with role '${userRole}' is authorized to view history for '${employeeId}'.`);

        // 2. --- Validate Employee Existence ---
        const { Item: empItem } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));
        if (!empItem) {
            console.warn(`Validation failed: Employee with ID '${employeeId}' not found.`);
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`Target employee '${employeeId}' confirmed to exist.`);

        // 3. --- Build DynamoDB Query ---
        // This is more efficient as it pushes date filtering to the database level.
        console.log("Step 2: Building DynamoDB query...");
        const pageLimit = limit ? parseInt(limit, 10) : 100;
        let keyConditionExpression = 'PK = :pk';
        const expressionAttributeValues = { ':pk': { S: `EMP#${employeeId}` } };

        if (startDate && endDate) {
            keyConditionExpression += ' AND SK BETWEEN :start AND :end';
            expressionAttributeValues[':start'] = { S: startDate };
            expressionAttributeValues[':end'] = { S: endDate };
        } else if (startDate) {
            keyConditionExpression += ' AND SK >= :start';
            expressionAttributeValues[':start'] = { S: startDate };
        } else if (endDate) {
            keyConditionExpression += ' AND SK <= :end';
            expressionAttributeValues[':end'] = { S: endDate };
        }

        const command = new QueryCommand({
            TableName: logTable,
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: pageLimit,
            ExclusiveStartKey: nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString('utf8')) : undefined,
            ScanIndexForward: true, // Show oldest first
        });
        
        console.log("Executing query:", JSON.stringify(command.input, null, 2));
        const { Items, LastEvaluatedKey } = await dbClient.send(command);
        
        // 4. --- Process and Format Results ---
        console.log(`Step 3: Processing ${Items?.length || 0} returned items...`);
        const timestamps = (Items || []).map(item => {
            const log = unmarshall(item);
            // Decrypt location if it exists
            if (log.location) {
                try {
                    log.location = decrypt(log.location);
                } catch (e) {
                    console.warn(`Could not decrypt location for log entry ${log.SK}.`);
                    log.location = 'DECRYPTION_ERROR';
                }
            }
            return log;
        });

        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64') : null;
        
        console.log(`Successfully retrieved ${timestamps.length} timestamp records.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                employeeId,
                timestamps: timestamps,
                nextToken: newNextToken
            })
        };

    } catch (err) {
        console.error('FATAL ERROR fetching timestamp history:', err);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Internal Server Error.', error: err.message })
        };
    }
};