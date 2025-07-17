// lambda/organization/wbs-codes/createWbsCode.js

const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { isAuthorized, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Add 'departmentId' as a required field for validation purposes
const requiredFields = ['wbsCode', 'description', 'costCenter', 'isActive', 'departmentId'];

exports.handler = async (event) => {
    console.log('Request to create a new WBS code received.');

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // 1. --- RBAC Enforcement: Admin roles only ---
    const allowedRoles = ['hr_admin', 'manager_admin'];
    if (!isAuthorized(event, allowedRoles)) {
        return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const { wbsCode, description, costCenter, isActive, departmentId } = body;
        
        // 2. --- Input and Format Validation ---
        const validationResult = validateBody(body, requiredFields);
        if (!validationResult.isValid) {
            console.warn('Validation failed:', validationResult.message);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: validationResult.message }),
            };
        }
        console.log('Input validation passed.');

        // 3. --- Validate Linked Department and Cost Center ---
        const getDeptCommand = new GetItemCommand({
            TableName: tableName,
            Key: marshall({ PK: `ORG#DEPARTMENT#${departmentId}`, SK: 'METADATA' }),
        });

        const { Item: departmentItem } = await dbClient.send(getDeptCommand);

        if (!departmentItem) {
            console.warn(`Validation failed: Linked department with ID ${departmentId} not found.`);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: `Invalid input: The linked department with ID ${departmentId} does not exist.` }),
            };
        }

        const departmentData = unmarshall(departmentItem);

        // Check if the cost center from the request matches the department's cost center
        if (departmentData.costCenter !== costCenter) {
            console.warn(`Validation failed: Provided cost center '${costCenter}' does not match the department's cost center '${departmentData.costCenter}'.`);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: `Invalid input: The provided cost center does not match the one associated with the linked department.` }),
            };
        }
        console.log(`Cost center validated successfully against department ${departmentId}.`);


        // 4. --- Prepare Core Data ---
        const pk = `ORG#WBS#${wbsCode}`;
        const sk = 'METADATA';
        const createdAt = new Date().toISOString();
        const createdBy = getRequestingUser(event);

        // 5. --- Construct the DynamoDB Item ---
        const wbsItem = {
            PK: pk,
            SK: sk,
            wbsCode: wbsCode,
            description: encrypt(description),
            costCenter: costCenter,
            isActive: isActive,
            departmentId: departmentId, // Store the link for future reference
            createdBy: createdBy,
            createdAt: createdAt,
        };

        const command = new PutItemCommand({
            TableName: tableName,
            Item: marshall(wbsItem),
            ConditionExpression: 'attribute_not_exists(PK)',
        });

        // 6. --- Execute Database Command ---
        await dbClient.send(command);
        console.log(`Successfully created WBS code '${wbsCode}'.`);
        // 7. --- Return Success Response ---
        return {
            statusCode: 201,
            headers: headers,
            body: JSON.stringify({
                message: 'WBS code created successfully.',
                wbsCode: wbsCode,
            }),
        };

    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            return {
                statusCode: 409,
                headers: headers,
                body: JSON.stringify({ message: `A WBS code with this name already exists.` }),
            };
        }
        console.error('An error occurred during WBS code creation:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to create WBS code.',
                error: error.message,
            }),
        };
    }
};