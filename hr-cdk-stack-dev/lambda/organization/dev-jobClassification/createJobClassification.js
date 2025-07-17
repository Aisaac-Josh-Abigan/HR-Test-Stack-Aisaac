// lambda/organization/dev-jobClassification/createJobClassification.js

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Define required fields based on the "Job Classification" schema
const requiredFields = [
    'jobFamily', 'jobTitle', 'payScale', 'responsibilities'
];

exports.handler = async (event) => {
    console.log('Received request to create a new job classification.');

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

        // 2. --- Prepare Core Data ---
        const jobClassificationId = uuidv4();
        // Adhere to the documented PK schema: ORG#<entityType>#<id>
        const pk = `ORG#JOB_CLASSIFICATION#${jobClassificationId}`;
        const sk = 'METADATA';
        const createdAt = new Date().toISOString();
        const createdBy = getRequestingUser(event);

        // 3. --- Construct the DynamoDB Item ---
        const jobClassificationItem = {
            PK: pk,
            SK: sk,
            jobClassificationId: jobClassificationId,
            jobFamily: body.jobFamily,
            jobTitle: body.jobTitle,
            payScale: body.payScale,
            // Encrypt the sensitive 'responsibilities' field
            responsibilities: encrypt(body.responsibilities),
            // Audit fields
            createdBy: createdBy,
            createdAt: createdAt,
        };

        const command = new PutItemCommand({
            TableName: tableName,
            Item: marshall(jobClassificationItem, { removeUndefinedValues: true }),
            // Use a condition to prevent accidentally overwriting an item
            ConditionExpression: 'attribute_not_exists(PK)',
        });

        // 4. --- Execute Database Command ---
        console.log('Creating job classification record in DynamoDB...');
        await dbClient.send(command);
        console.log(`Successfully created job classification with ID: ${jobClassificationId}`);
        
        return {
            statusCode: 201,
            headers: headers,
            body: JSON.stringify({
                message: 'Job classification created successfully.',
                jobClassificationId: jobClassificationId,
            }),
        };

    } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
            console.error('Data collision: An item with this key already exists.');
            return {
                statusCode: 409, // Conflict
                headers: headers,
                body: JSON.stringify({ message: 'A job classification with this ID already exists, which should not happen. Please try again.' }),
            };
        }
        console.error('An error occurred during job classification creation:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to create job classification.',
                error: error.message,
            }),
        };
    }
};