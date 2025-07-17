// lambda/organization/dev-orgUnit/createOrgUnit.js

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { getRequestingUser } = require('../../utils/authUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Required fields based on the "Organizational Unit" schema
const requiredFields = ['unitName', 'effectiveDate', 'description'];

exports.handler = async (event) => {
  // The {id} from the path is the departmentId
  const { id: departmentId } = event.pathParameters;
  console.log(`Request to create an organizational unit for department ID: ${departmentId}`);

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

    // 1. --- Input Validation for the Org Unit itself ---
    const validationResult = validateBody(body, requiredFields);
    if (!validationResult.isValid) {
      console.warn('Validation failed:', validationResult.message);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ message: validationResult.message }),
      };
    }
    console.log('Input validation passed for org unit body.');

    // 2. --- Validate Parent Department and Fetch its costCenter ---
    const deptKey = { PK: `ORG#DEPARTMENT#${departmentId}`, SK: 'METADATA' };
    const getDeptCommand = new GetItemCommand({
      TableName: tableName,
      Key: marshall(deptKey),
      ProjectionExpression: 'costCenter', // Only fetch the costCenter for efficiency
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
    const costCenterInfo = departmentData.costCenter;

    if (!costCenterInfo) {
      console.error(`Data integrity issue: Department ${departmentId} is missing a costCenter.`);
      return {
        statusCode: 500, // This is a server-side data issue, not a client error
        headers: headers,
        body: JSON.stringify({ message: 'Cannot create unit because the parent department has no cost center assigned.' }),
      };
    }
    console.log(`Parent department validated. Using cost center: ${costCenterInfo}`);

    // 3. --- Prepare Core Data for the New Org Unit ---
    const unitId = uuidv4();
    const pk = `ORG#ORG_UNIT#${unitId}`; // Standardized entity type name
    const sk = 'METADATA';
    const createdAt = new Date().toISOString();
    const createdBy = getRequestingUser(event);

    // 4. --- Construct the DynamoDB Item ---
    const orgUnitItem = {
      PK: pk,
      SK: sk,
      unitId: unitId,
      departmentId: departmentId, // Explicitly link back to the parent department
      unitName: encrypt(body.unitName),
      effectiveDate: body.effectiveDate, // From the request body
      description: encrypt(body.description),
      costCenterInfo: costCenterInfo, // Automatically populated from the department
      createdBy: createdBy,
      createdAt: createdAt,
    };

    const command = new PutItemCommand({
      TableName: tableName,
      Item: marshall(orgUnitItem, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    // 5. --- Execute Database Command ---
    console.log('Creating organizational unit record in DynamoDB...');
    await dbClient.send(command);
    console.log(`Successfully created organizational unit with ID: ${unitId}`);

    return {
      statusCode: 201,
      headers: headers,
      body: JSON.stringify({
        message: 'Organizational Unit created successfully.',
        unitId: unitId,
      }),
    };

  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        headers: headers,
        body: JSON.stringify({ message: 'An organizational unit with this ID already exists. Please try again.' }),
      };
    }
    console.error('An error occurred during organizational unit creation:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to create organizational unit.',
        error: error.message,
      }),
    };
  }
};