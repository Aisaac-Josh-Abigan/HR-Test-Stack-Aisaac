// lambda/time-management/leave-requests/dev-getLeaveBalance.js

const { DynamoDBClient, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized, getRequestingUser, getUserRole } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.TIME_MANAGEMENT_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// --- Helper Functions ---

async function getLeaveConfig() {
    const { Item } = await dbClient.send(new GetItemCommand({
        TableName: tableName,
        Key: { PK: { S: 'CONFIG#LEAVE' }, SK: { S: 'SINGLETON' } }
    }));
    if (!Item) throw new Error('Leave policy configuration not found.');
    return unmarshall(Item);
}

// Efficiently fetches all APPROVED leave requests for an employee using the GSI.
async function getApprovedLeavesForEmployee(employeeId) {
    const command = new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        FilterExpression: 'approvalStatus = :status',
        ExpressionAttributeValues: {
            ':pk': { S: `EMP#${employeeId}` },
            ':status': { S: 'Approved' } // Correctly filter for approved leaves
        }
    });
    const { Items = [] } = await dbClient.send(command);
    return Items.map(unmarshall);
}

exports.handler = async (event) => {
    console.log("Request to get leave balance received:", event);
    try {
        const { employeeId } = event.pathParameters;

        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and parameters...");
        const allowedRoles = ['employee', 'hr_admin', 'manager_admin'];
        if (!isAuthorized(event, allowedRoles)) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }
        if (!employeeId) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId is required.' }) };
        }

        const userRole = getUserRole(event);
        const requestingEmployeeId = getRequestingUser(event);

        if (userRole === 'employee' && requestingEmployeeId !== employeeId) {
            console.warn(`Authorization failure: Employee '${requestingEmployeeId}' attempted to access balance for '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only view your own leave balance.' }) };
        }
        console.log(`User '${requestingEmployeeId}' with role '${userRole}' is authorized to view balance for '${employeeId}'.`);

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
        
        // 2. --- Fetch Config and Approved Leaves ---
        console.log("Step 2: Fetching leave policy and employee's approved leaves...");
        const [config, approvedLeaves] = await Promise.all([
            getLeaveConfig(),
            getApprovedLeavesForEmployee(employeeId)
        ]);
        console.log(`Found ${approvedLeaves.length} approved leave records for employee '${employeeId}'.`);

        // 3. --- Aggregate Used Days ---
        console.log("Step 3: Aggregating used leave days by type...");
        const usedDays = {};
        for (const leave of approvedLeaves) {
            const type = leave.leaveType;
            usedDays[type] = (usedDays[type] || 0) + leave.totalDays;
        }

        // 4. --- Calculate Final Balances ---
        console.log("Step 4: Calculating final leave balances...");
        const leaveBalance = {};
        const policy = config.leavePolicy || {};
        for (const type in policy) {
            const entitlement = policy[type];
            const used = usedDays[type] || 0;
            leaveBalance[type] = {
                entitlement: entitlement,
                used: used,
                remaining: entitlement - used,
            };
        }

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ employeeId, leaveBalance })
        };

    } catch (err) {
        console.error('FATAL ERROR fetching leave balance:', err);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Internal Server Error.', error: err.message })
        };
    }
};