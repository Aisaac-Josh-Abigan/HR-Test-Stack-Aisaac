// lambda/organization/dev-position/createPositionMethod.js

const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { validateBody } = require('../../utils/validationUtil');
const { getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Required fields based on the "Positions (Simple Form)" schema
const requiredFields = [
    'positionTitle', 'salaryGrade', 'positionCode'
];

exports.handler = async (event) => {
    // The {id} from the path is the departmentId
    const { id: departmentId } = event.pathParameters;
    console.log(`Request to create a simple position for department ID: ${departmentId}`);

    // Define CORS headers for this POST endpoint
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (!departmentId) {
        return {
            statusCode: 400,
            headers: headers,
            body: JSON.stringify({ message: 'Department ID is required in the URL path.' }),
        };
    }

    try {
        const body = JSON.parse(event.body);

        // 1. --- Input Validation for the Position itself ---
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

        // 2. --- Validate Parent Department and Fetch its Manager ---
        const deptKey = {
            PK: `ORG#DEPARTMENT#${departmentId}`,
            SK: 'METADATA',
        };
        const getDeptCommand = new GetItemCommand({
            TableName: tableName,
            Key: marshall(deptKey),
            // Only fetch the departmentManager field for efficiency
            ProjectionExpression: 'departmentManager',
        });
        
        const { Item: departmentItem } = await dbClient.send(getDeptCommand);

        if (!departmentItem) {
            console.warn(`Validation failed: Department with ID ${departmentId} not found.`);
            return {
                statusCode: 404,
                headers: headers,
                body: JSON.stringify({ message: `Department with ID ${departmentId} not found.` }),
            };
        }
        
        const departmentData = unmarshall(departmentItem);
        const reportsToManagerId = departmentData.departmentManager;

        if (!reportsToManagerId) {
            console.error(`Data integrity issue: Department ${departmentId} is missing a departmentManager.`);
            return {
                statusCode: 500,
                headers: headers,
                body: JSON.stringify({ message: 'Cannot create position because the department has no manager assigned.' }),
            };
        }
        console.log(`Parent department validated. Position will report to manager: ${reportsToManagerId}`);

        // 3. --- Prepare Core Data for the New Position ---
        const positionId = uuidv4();
        // A simple position can use the POSITION entity type for its PK
        const pk = `ORG#POSITION#${positionId}`;
        const sk = 'METADATA';
        const createdAt = new Date().toISOString();
        const createdBy = getRequestingUser(event);

        // 4. --- Construct the DynamoDB Item ---
        const positionItem = {
            PK: pk,
            SK: sk,
            positionId: positionId,
            positionTitle: body.positionTitle,
            salaryGrade: body.salaryGrade,
            positionCode: body.positionCode,
            departmentId: departmentId, // Explicitly link back to the parent department
            // Automatically populated fields
            reportsTo: reportsToManagerId, // Automatically set from the department's manager
            // Audit fields
            createdBy: createdBy,
            createdAt: createdAt,
        };

        const command = new PutItemCommand({
            TableName: tableName,
            Item: marshall(positionItem, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK)',
        });

        // 5. --- Execute Database Command ---
        console.log('Creating simple position record in DynamoDB...');
        await dbClient.send(command);
        console.log(`Successfully created simple position with ID: ${positionId}`);
        
        return {
            statusCode: 201,
            headers: headers,
            body: JSON.stringify({
                message: 'Simple position created successfully.',
                positionId: positionId,
            }),
        };

    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.error('Data collision: An item with this key already exists.');
            return {
                statusCode: 409, // Conflict
                headers: headers,
                body: JSON.stringify({ message: 'A position with this ID already exists, which should not happen. Please try again.' }),
            };
        }
        console.error('An error occurred during simple position creation:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to create simple position.',
                error: error.message,
            }),
        };
    }
};