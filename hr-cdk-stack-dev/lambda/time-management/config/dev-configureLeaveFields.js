// lambda/time-management/config/dev-configureLeaveFields.js

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');
const { validateBody } = require('../../utils/validationUtil'); // Import the validation utility

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.TIME_MANAGEMENT_TABLE_NAME;

const CONFIG_PK = 'CONFIG#LEAVE';
const CONFIG_SK = 'SINGLETON';

// Define the required top-level keys for the configuration object
const requiredFields = ['enabledFields', 'validationRules', 'leavePolicy'];

exports.handler = async (event) => {
    console.log('Request to configure leave fields received.');

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // 1. --- RBAC Enforcement: Admin only ---
    const allowedRoles = ['hr_admin'];
    if (!isAuthorized(event, allowedRoles)) {
        return {
            statusCode: 403,
            headers: headers,
            body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }),
        };
    }

    try {
        const body = JSON.parse(event.body);
        
        // 2. --- Input Validation using the utility ---
        const validationResult = validateBody(body, requiredFields);
        if (!validationResult.isValid) {
            console.warn('Validation failed:', validationResult.message);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: validationResult.message }),
            };
        }
        
        // Add more specific validation for the structure of the nested objects
        if (!Array.isArray(body.enabledFields) || typeof body.validationRules !== 'object' || typeof body.leavePolicy !== 'object') {
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: 'Bad Request: Invalid data types for configuration fields. enabledFields must be an array, validationRules and leavePolicy must be objects.' }),
            };
        }
        console.log('Input validation passed.');

        // 3. --- Prepare and Construct the Item ---
        const updatedBy = getRequestingUser(event);
        const updatedAt = new Date().toISOString();

        const configItem = {
            PK: CONFIG_PK,
            SK: CONFIG_SK,
            configId: `config-leave-${uuidv4()}`,
            formType: 'LEAVE_CONFIG',
            enabledFields: body.enabledFields,
            validationRules: body.validationRules,
            leavePolicy: body.leavePolicy,
            updatedBy: updatedBy,
            updatedAt: updatedAt,
        };

        const command = new PutItemCommand({
            TableName: tableName,
            Item: marshall(configItem),
        });

        // 4. --- Execute Database Command ---
        await dbClient.send(command);
        console.log(`Leave configuration successfully updated by ${updatedBy}`);

        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ message: 'Leave configuration updated successfully.' }),
        };

    } catch (error) {
        console.error('Error configuring leave fields:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to update leave configuration.',
                error: error.message,
            }),
        };
    }
};