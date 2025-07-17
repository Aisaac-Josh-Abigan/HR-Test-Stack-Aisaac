// lambda/time-management/leave-requests/dev-createLeaveRequest.js

const { DynamoDBClient, PutItemCommand, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.TIME_MANAGEMENT_TABLE_NAME;
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// --- Helper Functions ---

function normalizeDate(input) {
    if (!input) return null;

    // Convert MM/DD/YYYY → YYYY-MM-DD
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
        return new Date(input.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2'));
    }

    // Convert YYYY/MM/DD → YYYY-MM-DD
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(input)) {
        return new Date(input.replace(/\//g, '-'));
    }

    return new Date(input); // ISO or already correct
}

async function getLeaveConfig() {
    const { Item } = await dbClient.send(new GetItemCommand({
        TableName: tableName,
        Key: marshall({ PK: 'CONFIG#LEAVE', SK: 'SINGLETON' })
    }));
    if (!Item) throw new Error('Leave configuration not found. Please contact an administrator.');
    return unmarshall(Item);
}

async function getActiveLeavesForEmployee(employeeId) {
    // Use the efficient GSI1 to query for an employee's approved/pending leaves.
    const command = new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression: 'approvalStatus IN (:pending, :approved)',
        ExpressionAttributeValues: {
            ':gsi1pk': { S: `EMP#${employeeId}` },
            ':pending': { S: 'Pending' },
            ':approved': { S: 'Approved' },
        }
    });
    const { Items } = await dbClient.send(command);
    return Items ? Items.map(unmarshall) : [];
}

// --- Main Handler ---
exports.handler = async (event) => {
    console.log('Create leave request initiated.', event);
    try {
        // 1. --- Authorization and Ownership ---
        console.log("Step 1: Validating authorization...");
        if (!isAuthorized(event, ['employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }
        
        const body = JSON.parse(event.body);
        const { employeeId, leaveType, startDate, endDate, reason, halfDay = false, isEmergency = false } = body;
        const requestingEmployeeId = getRequestingUser(event);

        if (requestingEmployeeId !== employeeId) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only submit leave requests for yourself.' }) };
        }
        console.log(`User '${employeeId}' is authorized.`);

        // 2. --- Basic Input Validation ---
        console.log("Step 2: Performing basic input validation...");
        const validationResult = validateBody(body, ['employeeId', 'leaveType', 'startDate', 'endDate', 'reason']);
        if (!validationResult.isValid) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }

        const start = normalizeDate(startDate);
        const end = normalizeDate(endDate);
        if (end < start) throw new Error('Invalid date range: End date cannot be before start date.');
        
        // 3. --- Fetch Config and Existing Leaves ---
        console.log("Step 3: Fetching leave configuration and existing employee leaves...");
        const [config, existingLeaves] = await Promise.all([
            getLeaveConfig(),
            getActiveLeavesForEmployee(employeeId),
        ]);
        
        // 4. --- Advanced Business Rule Validation ---
        console.log("Step 4: Performing advanced business rule validation...");
        const { validationRules, leavePolicy } = config;
        
        // a. Leave Type Validation
        if (!leavePolicy || !leavePolicy[leaveType]) throw new Error(`Invalid leave type: '${leaveType}' is not a valid policy.`);

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Normalize to the beginning of the day

        // b. Notice Period and Past Date Validation (skipped for emergency requests)
        if (!isEmergency) {
            const minNoticeDate = new Date();
            minNoticeDate.setDate(minNoticeDate.getDate() + validationRules.minNoticePeriod);
            if (start < minNoticeDate) throw new Error(`Leave must be requested at least ${validationRules.minNoticePeriod} days in advance.`);
            if (start < today) throw new Error('Leave dates cannot be in the past, except for emergency requests.');
        }

        // c. Duration Validation
        const totalDays = halfDay ? 0.5 : ((end - start) / (1000 * 60 * 60 * 24)) + 1;
        if (totalDays > validationRules.maxDuration) throw new Error(`Leave duration of ${totalDays} days exceeds the maximum of ${validationRules.maxDuration} days.`);
        
        // d. Overlap Validation
        const requestedStart = start.getTime();
        const requestedEnd = end.getTime();
        const isOverlapping = existingLeaves.some(leave => {
            const existingStart = new Date(leave.startDate).getTime();
            const existingEnd = new Date(leave.endDate).getTime();
            return Math.max(requestedStart, existingStart) <= Math.min(requestedEnd, existingEnd);
        });
        if (isOverlapping) throw new Error('The requested leave dates overlap with an existing leave request.');
        
        // e. Balance Validation
        const usedBalance = existingLeaves.filter(l => l.leaveType === leaveType).reduce((acc, l) => acc + l.totalDays, 0);
        const entitlement = leavePolicy[leaveType];
        const remainingBalance = entitlement - usedBalance;
        if (totalDays > remainingBalance) throw new Error(`Insufficient leave balance. Remaining: ${remainingBalance}, Requested: ${totalDays}.`);
        
        // f. Auto-Approval / Auto-Reject Validation
        let approvalStatus = 'Pending'; // Default status
        if (validationRules.requireManagerApproval === false) {
            const autoApprovalLimit = validationRules.autoApprovalLimitDays || 0;
            if (totalDays <= autoApprovalLimit) {
                approvalStatus = 'Approved';
            } else {
                throw new Error(`Leave request exceeds the auto-approval limit of ${autoApprovalLimit} days.`);
            }
        }
        console.log("All validations passed.");

        // 5. --- Construct and Save Leave Record ---
        console.log(`Step 5: Constructing leave request with status: ${approvalStatus}`);
        const requestId = uuidv4();
        const createdAt = new Date().toISOString();
        
        const leaveItem = {
            PK: `TIME#LEAVE#${requestId}`,
            SK: 'METADATA',
            GSI1PK: `EMP#${employeeId}`,
            GSI1SK: `LEAVE#${startDate}`,
            requestId, employeeId, leaveType, startDate, endDate, totalDays,
            formType: 'LEAVE_REQUEST',
            paidLeave: body.paidLeave !== undefined ? body.paidLeave : true,
            halfDay, reason: encrypt(reason), approvalStatus,
            leaveBalance: { before: remainingBalance, after: remainingBalance - totalDays },
            createdBy: requestingEmployeeId, createdAt
        };

        await dbClient.send(new PutItemCommand({
            TableName: tableName, Item: marshall(leaveItem, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK)'
        }));

        console.log(`Leave request ${requestId} created successfully.`);
        return { statusCode: 201, headers: headers, body: JSON.stringify({ message: 'Leave request submitted successfully.', requestId }) };

    } catch (error) {
        console.error('Error creating leave request:', error);
        return {
            statusCode: 400, // Most errors in this flow are client-side validation failures
            headers: headers,
            body: JSON.stringify({ message: 'Failed to submit leave request.', error: error.message })
        };
    }
};