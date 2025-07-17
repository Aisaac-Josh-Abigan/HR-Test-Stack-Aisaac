// lambda/time-management/config/dev-getLeaveConfig.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { isAuthorized } = require('../../utils/authUtil'); // Import the authorization utility

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.TIME_MANAGEMENT_TABLE_NAME;

const CONFIG_PK = 'CONFIG#LEAVE';
const CONFIG_SK = 'SINGLETON';

exports.handler = async (event) => {
    console.log('Request to get leave configuration received.');

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    // 1. --- RBAC Enforcement: HR Admin and Employee only ---
    const allowedRoles = ['hr_admin', 'employee'];
    if (!isAuthorized(event, allowedRoles)) {
        return {
            statusCode: 403, // Forbidden
            headers: headers,
            body: JSON.stringify({ message: 'Forbidden: You do not have permission to view this configuration.' }),
        };
    }
    // --- End of RBAC Check ---

    const params = {
        TableName: tableName,
        Key: {
            PK: { S: CONFIG_PK },
            SK: { S: CONFIG_SK }
        }
    };

    try {
        const { Item } = await dbClient.send(new GetItemCommand(params));

        if (!Item) {
            console.warn('Leave configuration has not been set yet.');
            return {
                statusCode: 404,
                headers: headers,
                body: JSON.stringify({ message: 'Leave configuration not found. Please have an administrator configure it first.' }),
            };
        }

        const config = unmarshall(Item);

        // Remove internal-facing keys before sending to the client
        delete config.PK;
        delete config.SK;

        console.log('Successfully retrieved leave configuration.');
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ leaveConfiguration: config }),
        };

    } catch (error) {
        console.error('Error retrieving leave configuration:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to retrieve leave configuration.',
                error: error.message,
            }),
        };
    }
};