// lambda/time-management/timestamp-logging/dev-createTimestamp.js

const { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');
const { validateWbsCodeForEmployee } = require('../../utils/wbsValidationUtil');
const crypto = require('crypto');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// --- Helper Functions ---

function generateHash(logEntry) {
    // This hash is based on a stable, defined set of the most critical data points.
    const dataToHash = `${logEntry.timestamp}${logEntry.timestampType}${logEntry.sequenceNumber}${logEntry.wbsCode || ''}`;
    return crypto.createHash('sha256').update(dataToHash).digest('hex');
}

async function validateEmployee(employeeId) {
    const { Item } = await dbClient.send(new GetItemCommand({
        TableName: personnelTable,
        Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' }),
    }));
    if (!Item) throw new Error('Employee not found.');
    const employee = unmarshall(Item);
    if (employee.status !== 'ACTIVE') throw new Error('Employee is not active.');
    return employee;
}

async function getLatestTimestamp(employeeId) {
    const { Items } = await dbClient.send(new QueryCommand({
        TableName: logTable,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: `EMP#${employeeId}` } },
        ScanIndexForward: false, // Sort descending to get the latest
        Limit: 1,
    }));
    return Items && Items.length > 0 ? unmarshall(Items[0]) : null;
}

async function resolveWbsCode(employeeId) {
    const { Item } = await dbClient.send(new GetItemCommand({
        TableName: personnelTable,
        Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#CONTRACT_DETAILS' }),
        ProjectionExpression: 'department',
    }));
    const departmentId = unmarshall(Item)?.department;
    if (!departmentId) throw new Error('Employee is not assigned to a department.');

    const { Items: wbsItems } = await dbClient.send(new QueryCommand({
        TableName: orgTable,
        IndexName: 'departmentId-index',
        KeyConditionExpression: 'departmentId = :deptId',
        FilterExpression: 'isActive = :true',
        ExpressionAttributeValues: {
            ':deptId': { S: departmentId },
            ':true': { BOOL: true }
        }
    }));
    if (!wbsItems || wbsItems.length === 0) throw new Error(`No active WBS code found for employee's department.`);
    return unmarshall(wbsItems[0]).wbsCode;
}

exports.handler = async (event) => {
    console.log("Timestamp creation request initiated.");
    try {
        // 1. --- Authorization & Input Validation ---
        console.log("Step 1: Validating authorization and input payload...");
        if (!isAuthorized(event, ['employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        
        const body = JSON.parse(event.body);
        // Destructure all variables from the body first.
        let { employeeId, timestampType, wbsCode, location, deviceId, ipAddress } = body;
        const requiredFields = ['employeeId', 'timestampType', 'deviceId', 'ipAddress'];
        const validationResult = validateBody(body, requiredFields);
        if (!validationResult.isValid) {
            console.warn(`Input validation failed: ${validationResult.message}`);
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }

        const requestingEmployeeId = getRequestingUser(event); // This gets custom:empId

        if (requestingEmployeeId !== employeeId) {
            console.error(`Authorization failure: User '${requestingEmployeeId}' attempted to log timestamp for employee '${employeeId}'.`);
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only submit logs for your own account.' }) };
        }
        console.log(`User '${employeeId}' is authorized. Input validation passed.`);

        // 2. --- Core Validations ---
        console.log("Step 2: Performing core data validations...");
        await validateEmployee(employeeId);
        console.log(`Employee '${employeeId}' confirmed to exist and be active.`);

        // --- NEW: WBS Code Validation Logic ---
        if (wbsCode) {
            // Call the shared utility function to perform all WBS checks.
            // It will throw an error if validation fails.
            await validateWbsCodeForEmployee(wbsCode, employeeId);
        } 
        else if (['CLOCK_IN', 'BREAK_END'].includes(timestampType)) {
            // This logic is for auto-assigning a code if one isn't provided.
            console.log(`WBS code not provided for ${timestampType}. Attempting to auto-resolve...`);
            wbsCode = await resolveWbsCode(employeeId);
            console.log(`Successfully auto-resolved WBS code to '${wbsCode}'.`);
        }

        // 3. --- Process Timestamp Logic & State Validation ---
        console.log("Step 3: Processing timestamp sequence and validating state logic...");
        const timestamp = new Date().toISOString();
        const latestLog = await getLatestTimestamp(employeeId);
        
        let sequenceNumber = 1;
        let previousTimestamp = null;
        let hashChain = 'GENESIS';

        if (latestLog) {
            console.log(`Found previous log entry. Type: ${latestLog.timestampType}, Sequence: ${latestLog.sequenceNumber}`);
            
            // State machine validation to ensure correct event sequencing
            const lastAction = latestLog.timestampType;
            const validTransitions = {
                'CLOCK_IN': ['BREAK_START', 'WBS_CHANGE', 'CLOCK_OUT'],
                'CLOCK_OUT': ['CLOCK_IN'],
                'BREAK_START': ['BREAK_END', 'WBS_CHANGE'],
                'BREAK_END': ['BREAK_START', 'WBS_CHANGE', 'CLOCK_OUT'],
                'WBS_CHANGE': ['BREAK_START', 'WBS_CHANGE', 'CLOCK_OUT'],
            };

            if (!validTransitions[lastAction] || !validTransitions[lastAction].includes(timestampType)) {
                 console.warn(`Validation failed: Transition from '${lastAction}' to '${timestampType}' is not allowed.`);
                 throw new Error(`Invalid action: Cannot perform '${timestampType}' after '${lastAction}'.`);
            }

            // General business rule validations
            if (new Date(timestamp) - new Date(latestLog.timestamp) > 24 * 60 * 60 * 1000) {
                console.warn("Validation failed: Timestamp gap > 24 hours.");
                throw new Error('Gap between timestamps cannot exceed 24 hours.');
            }

            sequenceNumber = latestLog.sequenceNumber + 1;
            previousTimestamp = latestLog.timestamp;
            hashChain = generateHash(latestLog);
            console.log(`Calculated new sequence number: ${sequenceNumber}. Generated hash chain.`);
        } else {
            // If there's no previous log, the only valid first action is CLOCK_IN
            if (timestampType !== 'CLOCK_IN') {
                throw new Error('Invalid first action: The first timestamp for an employee must be a CLOCK_IN.');
            }
            console.log("No previous log entry found. This is the first timestamp for this employee.");
        }

        // 4. --- Construct Final Item ---
        console.log("Step 4: Constructing final DynamoDB item...");
        const dateOnly = timestamp.split('T')[0];
        const item = {
            PK: `EMP#${employeeId}`,
            SK: timestamp,
            GSI1PK: `DATE#${dateOnly}`,
            GSI1SK: `EMP#${employeeId}#${timestampType}`,
            GSI2PK: wbsCode ? `WBS#${wbsCode}` : 'WBS#N/A',
            GSI2SK: `${dateOnly}#EMP#${employeeId}`,
            employeeId,
            timestampType,
            timestamp,
            previousTimestamp,
            sequenceNumber,
            wbsCode: wbsCode || latestLog?.wbsCode || null,
            location: location ? encrypt(location) : null,
            deviceId,
            ipAddress,
            hashChain,
            validated: true, // System-validated
            createdAt: timestamp
        };

        if(timestampType === 'WBS_CHANGE'){
            if (!body.wbsChangeReason) throw new Error("wbsChangeReason is required for WBS_CHANGE timestamp type.");
            item.previousWbsCode = latestLog?.wbsCode;
            item.wbsChangeReason = body.wbsChangeReason;
            console.log(`Logging WBS_CHANGE event. Previous WBS: '${item.previousWbsCode}', Reason: '${item.wbsChangeReason}'.`);
        }

        console.log("Final item constructed:", JSON.stringify(item, null, 2));

        // 5. --- Execute Database Command ---
        console.log("Step 5: Writing timestamp item to DynamoDB...");
        await dbClient.send(new PutItemCommand({
            TableName: logTable,
            Item: marshall(item, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
        }));
        console.log("Successfully wrote item to DynamoDB.");

        return {
            statusCode: 201,
            headers: headers,
            body: JSON.stringify({ 
                message: 'Timestamp recorded successfully.',
                timestamp: timestamp 
            })
        };

    } catch (err) {
        console.error('FATAL ERROR in createTimestamp handler:', err);
        return {
            statusCode: 400,
            headers: headers,
            body: JSON.stringify({ message: err.message || 'An error occurred.' })
        };
    }
};