// lambda/organization/dev-position/createPosition.js

const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');
const { getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Required fields based on the "Position (Stepper Form)" schema
const positionRequiredFields = [
  'positionTitle', 'positionCode', 'departmentId', 'positionLevel',
  'employmentType', 'education', 'skills', 'certifications', 
  'salaryGrade', 'competencyLevel'
];

exports.handler = async (event) => {
  console.log('Received request to create a new position.');

  // Define CORS headers for this POST endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  try {
    const body = JSON.parse(event.body);

    // 1. --- Input Validation ---
    const validationResult = validateBody(body, positionRequiredFields);
    if (!validationResult.isValid) {
      console.warn('Validation failed:', validationResult.message);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ message: validationResult.message }),
      };
    }
    console.log('Input validation passed.');

    // 2. --- Validate Parent Department and Fetch its Manager (in one call) ---
    const departmentId = body.departmentId; // Using departmentId as agreed
    const getDeptCommand = new GetItemCommand({
      TableName: tableName,
      Key: marshall({
        PK: `ORG#DEPARTMENT#${departmentId}`,
        SK: 'METADATA'
      }),
      // Only fetch the departmentManager field for efficiency
      ProjectionExpression: 'departmentManager',
    });

    const { Item: departmentItem } = await dbClient.send(getDeptCommand);

    if (!departmentItem) {
      console.warn(`Validation failed: Department with ID ${departmentId} not found.`);
      return {
        statusCode: 400, // Bad Request because the referenced department doesn't exist
        headers: headers,
        body: JSON.stringify({ message: `Invalid input: Department with ID ${departmentId} not found.` }),
      };
    }

    const departmentData = unmarshall(departmentItem);
    const reportsToManagerId = departmentData.departmentManager; // Correct attribute name

    if (!reportsToManagerId) {
      console.error(`Data integrity issue: Department ${departmentId} is missing a departmentManager.`);
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ message: 'Cannot create position because the specified department has no manager assigned.' }),
      };
    }
    console.log(`Parent department validated. Position will report to manager: ${reportsToManagerId}`);
    
    // 3. --- Prepare Core Data ---
    const positionId = uuidv4();
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
      positionCode: body.positionCode,
      departmentId: departmentId, // Store the departmentId
      positionLevel: body.positionLevel,
      employmentType: body.employmentType,
      reportsTo: reportsToManagerId, // Automatically populated from department
      positionDescription: body.positionDescription ? encrypt(body.positionDescription) : undefined, // Encrypt optional field
      education: body.education,
      skills: body.skills, // DynamoDB natively supports string sets
      certifications: body.certifications, // DynamoDB natively supports string sets
      salaryGrade: body.salaryGrade,
      competencyLevel: body.competencyLevel,
      comments: body.comments ? encrypt(body.comments) : undefined, // Encrypt optional field
      createdBy: createdBy,
      createdAt: createdAt,
    };

    const command = new PutItemCommand({
      TableName: tableName,
      Item: marshall(positionItem, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(PK)'
    });

    // 5. --- Execute Database Command ---
    console.log(`Creating position record in DynamoDB for ID: ${positionId}...`);
    await dbClient.send(command);
    console.log(`Successfully created position with ID: ${positionId}`);

    return {
      statusCode: 201,
      headers: headers,
      body: JSON.stringify({
        message: 'Position created successfully.',
        positionId: positionId,
      }),
    };

  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
        return {
            statusCode: 409,
            headers: headers,
            body: JSON.stringify({ message: 'A position with this ID already exists. Please try again.' }),
        };
    }
    console.error('An error occurred during position creation:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to create position.',
        error: error.message,
      }),
    };
  }
};