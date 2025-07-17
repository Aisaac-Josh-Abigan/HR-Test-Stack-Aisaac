// lambda/time-management/wbs-tracking/dev-changeWbsCode.js

const { validateBody } = require('../../utils/validationUtil');
const { isAuthorized, getRequestingUser, hasWbsPermission } = require('../../utils/authUtil');
const { validateWbsCodeForEmployee } = require('../../utils/wbsValidationUtil');
const createTimestamp = require('../timestamp-logging/dev-createTimestamp.js');

exports.handler = async (event) => {
    console.log("WBS change request initiated.", event);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    try {
        // 1. --- Authorization & RBAC ---
        console.log("Step 1: Validating authorization...");
        if (!isAuthorized(event, ['employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        if (!hasWbsPermission(event)) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to change WBS codes.' }) };
        }
        
        const requestingEmployeeId = getRequestingUser(event);
        const body = JSON.parse(event.body);
        const { employeeId, newWbsCode, reason, deviceId } = body;
        
        // Ownership check
        if (requestingEmployeeId !== employeeId) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You can only change your own WBS code.' }) };
        }
        console.log(`User '${employeeId}' is authorized to change WBS codes.`);

        // 2. --- Input Validation ---
        console.log("Step 2: Validating input payload...");
        // 'deviceId' is now required as it will be passed to the timestamp log.
        const validationResult = validateBody(body, ['employeeId', 'newWbsCode', 'reason', 'deviceId']);
        if (!validationResult.isValid) {
            console.warn(`Validation failed: ${validationResult.message}`);
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }

        // WBS code validation
        await validateWbsCodeForEmployee(newWbsCode, employeeId);
        console.log(`WBS code '${newWbsCode}' validated successfully.`);

        // 3. --- Delegate to Timestamp Creation Logic ---
        console.log("Step 3: Preparing to log a WBS_CHANGE timestamp event...");
        const timestampEventBody = {
            employeeId: employeeId,
            timestampType: 'WBS_CHANGE',
            wbsCode: newWbsCode,
            wbsChangeReason: reason,
            deviceId: deviceId,
            ipAddress: event.requestContext.identity.sourceIp
        };
        
        const timestampEvent = {
            ...event,
            body: JSON.stringify(timestampEventBody)
        };
        
        // Directly invoke the createTimestamp handler's logic
        const timestampResult = await createTimestamp.handler(timestampEvent);

        // 4. --- Handle and Return Response ---
        if (timestampResult.statusCode >= 400) {
            console.error("The underlying createTimestamp function returned an error:", timestampResult.body);
            return timestampResult;
        }

        console.log("WBS change successfully logged as a timestamp event.");
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                message: 'WBS code change recorded successfully.',
                newWbsCode: newWbsCode,
                timestamp: JSON.parse(timestampResult.body).timestamp,
            })
        };

    } catch (err) {
        console.error('FATAL ERROR in changeWbsCode handler:', err);
        // Return a 400 for validation errors, 500 for true server errors
        const statusCode = err.message.includes('permission') || err.message.includes('not valid') ? 400 : 500;
        return { 
            statusCode, 
            headers: headers, 
            body: JSON.stringify({ message: err.message || 'Internal Server Error.' }) 
        };
    }
};