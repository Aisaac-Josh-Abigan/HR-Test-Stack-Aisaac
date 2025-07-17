// lambda/time-management/timestamp-logging/dev-validateTimestamps.js

const { DynamoDBClient, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');
const crypto = require('crypto');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const logTable = process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// --- Helper Functions ---
async function fetchAllTimestampLogs(employeeId) {
    let allLogs = [];
    let lastEvaluatedKey = undefined;

    do {
        const command = new QueryCommand({
            TableName: logTable,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': { S: `EMP#${employeeId}` } },
            ScanIndexForward: true, // Oldest first is essential for validation
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const { Items, LastEvaluatedKey } = await dbClient.send(command);
        if (Items) {
            allLogs.push(...Items.map(unmarshall));
        }
        lastEvaluatedKey = LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return allLogs;
}

function generateHash(logEntry) {
    // A stable hash should be based on a consistent representation of the data
    const dataToHash = `${logEntry.timestamp}${logEntry.timestampType}${logEntry.sequenceNumber}${logEntry.wbsCode || ''}`;
    return crypto.createHash('sha256').update(dataToHash).digest('hex');
}

exports.handler = async (event) => {
    console.log("Timestamp validation request received:", event);
    try {
        const { employeeId } = event.pathParameters;

        // 1. --- Authorization & Initial Validation ---
        console.log("Step 1: Validating authorization and parameters...");
        if (!isAuthorized(event, ['hr_admin', 'manager_admin'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        if (!employeeId) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'employeeId is required in path parameters.' }) };
        }
        const validatedBy = getRequestingUser(event);

        const { Item } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#PERSONAL_DATA' })
        }));
        if (!Item) {
            return { statusCode: 404, headers: headers, body: JSON.stringify({ message: 'Employee not found.' }) };
        }
        console.log(`User '${validatedBy}' is authorized. Target employee '${employeeId}' exists.`);

        // 2. --- Fetch All Logs ---
        console.log(`Step 2: Fetching all timestamp logs for employee '${employeeId}'...`);
        const timestampLogs = await fetchAllTimestampLogs(employeeId);

        if (timestampLogs.length === 0) {
            return { statusCode: 200, headers: headers, body: JSON.stringify({ validationStatus: 'VALID', message: 'No logs to validate.' }) };
        }
        console.log(`Found ${timestampLogs.length} logs to validate.`);

        // 3. --- Perform Validations ---
        console.log("Step 3: Performing sequence, chronological, hash, state, and break validations...");
        const validationResults = []; // To store results for each log entry
        const errorDetails = { sequence: [], chronological: [], hash: [], state: [], breaks: [] };
        let clockedIn = false, onBreak = false;

        for (let i = 0; i < timestampLogs.length; i++) {
            const current = timestampLogs[i];
            const previous = i > 0 ? timestampLogs[i - 1] : null;
            
            // This object will hold errors for the current log entry
            const logValidation = {
                timestamp: current.timestamp,
                sequenceNumber: current.sequenceNumber,
                timestampType: current.timestampType,
                errors: []
            };

            // Sequence, Chronological, and Hash Validations (logic is the same, just pushes to logValidation.errors)
            if (current.sequenceNumber !== i + 1) logValidation.errors.push(`Expected sequence ${i + 1}.`);
            if (previous && new Date(current.timestamp) <= new Date(previous.timestamp)) logValidation.errors.push(`Not chronological.`);
            if (previous) {
                if (current.hashChain !== generateHash(previous)) logValidation.errors.push('Hash mismatch.');
            } else if (current.hashChain !== 'GENESIS') {
                logValidation.errors.push('First hash should be GENESIS.');
            }
            
            // State Transition Validation
            if (current.timestampType === 'CLOCK_IN') {
                if (clockedIn) logValidation.errors.push('Cannot CLOCK_IN while already clocked in.');
                clockedIn = true; onBreak = false;
            } else if (current.timestampType === 'CLOCK_OUT') {
                if (!clockedIn) logValidation.errors.push('Cannot CLOCK_OUT if not clocked in.');
                if (onBreak) logValidation.errors.push('Cannot CLOCK_OUT while on break.');
                clockedIn = false; onBreak = false;
            } else if (current.timestampType === 'BREAK_START') {
                if (!clockedIn || onBreak) logValidation.errors.push('Invalid state for BREAK_START.');
                onBreak = true;
            } else if (current.timestampType === 'BREAK_END') {
                if (!onBreak) logValidation.errors.push('Cannot END_BREAK if not on break.');
                onBreak = false;
            }

            // If any errors were found for this log, add them to the main errorDetails object
            if (logValidation.errors.length > 0) {
                // Populate the main error details for the summary
                if(logValidation.errors.some(e => e.includes('sequence'))) errorDetails.sequence.push(logValidation);
                if(logValidation.errors.some(e => e.includes('chronological'))) errorDetails.chronological.push(logValidation);
                if(logValidation.errors.some(e => e.includes('Hash'))) errorDetails.hash.push(logValidation);
                if(logValidation.errors.some(e => e.includes('Cannot') || e.includes('Invalid state'))) errorDetails.state.push(logValidation);
            }
            validationResults.push(logValidation);
        }
        
        // Final state check
        if(clockedIn) errorDetails.state.push({ timestamp: 'final', errors: ['Final State Error: Employee is still clocked in.'] });
        if(onBreak) errorDetails.state.push({ timestamp: 'final', errors: ['Final State Error: Employee is still on break.'] });

        // --- NEW: Break Duration Validation ---
        const breaksByDate = {};
        let currentBreakStart = null;
        for (const log of timestampLogs) {
            const dateOnly = log.timestamp.split('T')[0];
            if (!breaksByDate[dateOnly]) breaksByDate[dateOnly] = 0;
            if (log.timestampType === 'BREAK_START') currentBreakStart = new Date(log.timestamp);
            else if (log.timestampType === 'BREAK_END' && currentBreakStart) {
                const durationMinutes = (new Date(log.timestamp) - currentBreakStart) / 60000;
                breaksByDate[dateOnly] += durationMinutes;
                currentBreakStart = null;
            }
        }
        for (const [date, totalMinutes] of Object.entries(breaksByDate)) {
            if (totalMinutes > 240) { // 4 hours = 240 minutes
                const errorMsg = `Total break duration of ${totalMinutes.toFixed(0)} minutes exceeds 4-hour limit.`;
                errorDetails.breaks.push({ date: date, error: errorMsg });
            }
        }
        console.log("Validation checks complete.");

        // 4. --- Format and Return Summary ---
        const overallValid = Object.values(errorDetails).every(arr => arr.length === 0);
        
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                employeeId,
                validationStatus: overallValid ? 'VALID' : 'INVALID',
                summary: {
                    totalLogs: timestampLogs.length,
                    sequenceErrors: errorDetails.sequence.length,
                    chronologicalErrors: errorDetails.chronological.length,
                    hashChainErrors: errorDetails.hash.length,
                    stateErrors: errorDetails.state.length,
                    breakValidationErrors: errorDetails.breaks.length, // Added to summary
                },
                errorDetails: errorDetails,
                validationResults: validationResults, // The per-entry log
                validatedAt: new Date().toISOString(),
                validatedBy: getRequestingUser(event)
            })
        };

    } catch (err) {
        console.error('FATAL ERROR validating timestamps:', err);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ message: 'Internal Server Error.', error: err.message }) };s
    }
};