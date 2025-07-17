// lambda/organization/dev-department/createDepartment.js

const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const orgTableName = process.env.ORGANIZATIONAL_TABLE_NAME;
const personnelTableName = process.env.PERSONNEL_TABLE_NAME;

// Define required fields for this endpoint
const requiredFields = [
    'departmentName', 'departmentCode', 'departmentType',
    'costCenter', 'departmentManager', 'organizationLevel',
    'allowSubDepartments', 'maximumPositions', 'reportingStructure',
    'budgetControl'
];

exports.handler = async (event) => {
    console.log('Received request to create a new department.');

    // Define CORS headers for this POST endpoint
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    
    try {
        const body = JSON.parse(event.body);
        
        // 1. --- Input Validation ---
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

        // 2. --- Existence Validation for Foreign Keys ---
        
        // a. Validate that the departmentManager exists and is active in the Personnel table
        const managerId = body.departmentManager;
        const managerCheckParams = {
            TableName: personnelTableName,
            Key: marshall({
                PK: `EMPLOYEE#${managerId}`,
                SK: 'SECTION#PERSONAL_DATA'
            }),
            ProjectionExpression: '#status',
            ExpressionAttributeNames: { '#status': 'status' }
        };

        const { Item: managerItem } = await dbClient.send(new GetItemCommand(managerCheckParams));
        if (!managerItem) {
            console.warn(`Validation failed: Department Manager with ID ${managerId} not found.`);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: `Invalid input: Department Manager with ID ${managerId} not found.` }),
            };
        }

        const managerData = unmarshall(managerItem);
        if (managerData.status !== 'ACTIVE') {
            console.warn(`Validation failed: Department Manager with ID ${managerId} is not active.`);
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ message: `Invalid input: Department Manager with ID ${managerId} is not active.` }),
            };
        }

        // b. Validate that the parentDepartment exists, if provided
        if (body.parentDepartment) {
            const parentId = body.parentDepartment;
            const parentDeptCheckParams = {
                TableName: orgTableName,
                Key: marshall({
                    PK: `ORG#DEPARTMENT#${parentId}`,
                    SK: 'METADATA'
                })
            };
            const { Item: parentItem } = await dbClient.send(new GetItemCommand(parentDeptCheckParams));

            if (!parentItem) {
                console.warn(`Validation failed: Parent Department with ID ${parentId} not found.`);
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: `Invalid input: Parent Department with ID ${parentId} not found.` }),
                };
            }

            const parentData = unmarshall(parentItem);
            console.log(`Parent Department with ID ${parentId} validated successfully.`);

            // Check if parent allows sub-departments
            if (!parentData.allowSubDepartments) {
                console.warn(`Parent Department with ID ${parentId} does not allow sub-departments.`);
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: `Invalid input: Parent Department with ID ${parentId} does not allow sub-departments.` }),
                };
            }
        }


        // 3. --- Prepare Core Data ---
        const departmentId = uuidv4();
        const pk = `ORG#DEPARTMENT#${departmentId}`;
        const sk = 'METADATA';
        const createdAt = new Date().toISOString();
        const createdBy = getRequestingUser(event);

        // 4. --- Construct the DynamoDB Item ---
        const departmentItem = {
            PK: pk,
            SK: sk,
            departmentId: departmentId,
            departmentManager: managerId,
            parentDepartment: body.parentDepartment,
            departmentName: encrypt(body.departmentName),
            description: body.description ? encrypt(body.description) : undefined,
            comments: body.comments ? encrypt(body.comments) : undefined,
            departmentCode: body.departmentCode,
            departmentType: body.departmentType,
            costCenter: body.costCenter,
            organizationLevel: body.organizationLevel,
            allowSubDepartments: body.allowSubDepartments,
            maximumPositions: body.maximumPositions,
            reportingStructure: body.reportingStructure,
            budgetControl: body.budgetControl,
            createdBy: createdBy,
            createdAt: createdAt,
        };

        const command = new PutItemCommand({
            TableName: orgTableName,
            Item: marshall(departmentItem, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK)',
        });

        // 5. --- Execute Database Command ---
        console.log('Creating department record in DynamoDB...');
        await dbClient.send(command);
        console.log(`Successfully created department with ID: ${departmentId}`);
        
        return {
            statusCode: 201,
            headers: headers,
            body: JSON.stringify({
                message: 'Department created successfully',
                departmentId: departmentId,
            }),
        };

    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            return {
                statusCode: 409,
                headers: headers,
                body: JSON.stringify({ message: 'A department with this ID already exists, which should not happen. Please try again.' }),
            };
        }
        console.error('An error occurred during department creation:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to create department.',
                error: error.message,
            }),
        };
    }
};