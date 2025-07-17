// lambda/time-management/leave-requests/dev-updateLeaveRequestStatus.js

const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const timeTable = process.env.TIME_MANAGEMENT_TABLE_NAME;
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'PUT, OPTIONS',
};

exports.handler = async (event) => {
    console.log("Request to update leave request status received.");
    try {
        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and input payload...");
        if (!isAuthorized(event, ['manager_admin'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: Only managers can approve or reject leave requests.' }) };
        }
        
        const body = JSON.parse(event.body);
        const { requestId, newStatus, rejectionReason } = body;
        const validationResult = validateBody(body, ['requestId', 'newStatus']);
        if (!validationResult.isValid) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }

        if (!['Approved', 'Rejected'].includes(newStatus)) {
            throw new Error("Invalid 'newStatus' value. Must be either 'Approved' or 'Rejected'.");
        }
        if (newStatus === 'Rejected' && !validateBody({ rejectionReason }, ['rejectionReason']).isValid) {
            throw new Error("A 'rejectionReason' is required when rejecting a leave request.");
        }
        console.log(`Request to update request '${requestId}' to status '${newStatus}'.`);

        // 2. --- Fetch Leave Request and Validate ---
        console.log("Step 2: Fetching leave request...");
        const leaveKey = { PK: `TIME#LEAVE#${requestId}`, SK: 'METADATA' };
        const { Item: leaveItem } = await dbClient.send(new GetItemCommand({ TableName: timeTable, Key: marshall(leaveKey) }));

        if (!leaveItem) {
            throw new Error(`Leave request with ID '${requestId}' not found.`);
        }
        const leaveRequest = unmarshall(leaveItem);

        // Idempotency Check: Ensure we're only updating a pending request.
        if (leaveRequest.approvalStatus !== 'Pending') {
            throw new Error(`This leave request is already finalized with status: '${leaveRequest.approvalStatus}'.`);
        }

        const managerId = getRequestingUser(event);
        console.log(`Manager '${managerId}' is authorized to perform this action.`);

        // 3. --- Construct Update and Save ---
        console.log("Step 3: Constructing and executing update command...");
        let updateExpression = 'SET #status = :newStatus, #approvedBy = :managerId, #approvedAt = :timestamp';
        const expressionAttributeNames = { '#status': 'approvalStatus', '#approvedBy': 'approvedBy', '#approvedAt': 'approvedAt' };
        const expressionAttributeValues = {
            ':newStatus': { S: newStatus },
            ':managerId': { S: managerId },
            ':timestamp': { S: new Date().toISOString() }
        };

        if (newStatus === 'Rejected') {
            updateExpression += ', #reason = :reason';
            expressionAttributeNames['#reason'] = 'rejectionReason';
            expressionAttributeValues[':reason'] = { S: rejectionReason };
        }
        
        const command = new UpdateItemCommand({
            TableName: timeTable,
            Key: marshall(leaveKey),
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: {
                ...expressionAttributeValues,
                ':pendingStatus': { S: 'Pending' }
            },
            ConditionExpression: 'approvalStatus = :pendingStatus',
        });
        
        await dbClient.send(command);
        
        console.log(`Successfully updated leave request '${requestId}' to status '${newStatus}'.`);
        return { statusCode: 200, headers: headers, body: JSON.stringify({ message: `Leave request successfully ${newStatus.toLowerCase()}.` }) };

    } catch (error) {
        let statusCode = 500;
        if (error.name === 'ConditionalCheckFailedException') {
            statusCode = 409;
            error.message = 'This leave request may have been updated by another user. Please refresh and try again.';
        } else if (error.message.includes('Invalid') || error.message.includes('not found') || error.message.includes('required')) {
            statusCode = 400;
        }
        
        console.error('Error updating leave request status:', error);
        return { statusCode, headers: headers, body: JSON.stringify({ message: 'Failed to update leave request.', error: error.message }) };
    }
};