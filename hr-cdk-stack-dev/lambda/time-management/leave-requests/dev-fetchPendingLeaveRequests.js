// lambda/time-management/leave-requests/dev-fetchPendingLeaveRequests.js

const { DynamoDBClient, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const timeTable = process.env.TIME_MANAGEMENT_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    console.log('Request to fetch pending leave requests received:', event);

    try {
        const { employeeId } = event.pathParameters;
        
        // 1. --- RBAC & Parameter Validation ---
        console.log("Step 1: Validating authorization...");
        // This endpoint is for managers admins.
        const allowedRoles = ['manager_admin'];
        if (!isAuthorized(event, allowedRoles)) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }
        
        if (!employeeId) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId is required in the path.' }) };
        }
        
        const requestingAdmin = getRequestingUser(event);
        console.log(`Admin user '${requestingAdmin}' is authorized. Proceeding to fetch requests for employee '${employeeId}'.`);

        // 2. --- Validate Employee Existence ---
        // It's still good practice to ensure the employee you're querying for actually exists.
        console.log("Step 2: Validating employee existence...");
        const { Item: empItem } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));

        if (!empItem) {
            console.warn(`Attempted to fetch requests for non-existent employee '${employeeId}'.`);
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`Target employee '${employeeId}' confirmed to exist.`);

        // 3. --- Fetch Pending Leave Requests using GSI ---
        console.log("Step 3: Querying for pending leave requests using GSI1...");
        const command = new QueryCommand({
            TableName: timeTable,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            FilterExpression: 'approvalStatus = :status',
            ExpressionAttributeValues: {
                ':pk': { S: `EMP#${employeeId}` },
                ':status': { S: 'Pending' }
            }
        });

        const { Items = [] } = await dbClient.send(command);
        console.log(`Found ${Items.length} pending leave requests for employee '${employeeId}'.`);

        // 4. --- Sanitize and Format Results ---
        // Since this is an admin endpoint, the full reason is always decrypted.
        const pendingRequests = Items.map(unmarshall).map(req => ({
            requestId: req.requestId,
            employeeId: req.employeeId,
            leaveType: req.leaveType,
            startDate: req.startDate,
            endDate: req.endDate,
            totalDays: req.totalDays,
            halfDay: req.halfDay,
            paidLeave: req.paidLeave,
            approvalStatus: req.approvalStatus,
            createdAt: req.createdAt,
            reason: decrypt(req.reason)
        }));

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ pendingRequests: pendingRequests })
        };

    } catch (error) {
        console.error('Error fetching pending leave requests:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to fetch pending leave requests.', error: error.message })
        };
    }
};