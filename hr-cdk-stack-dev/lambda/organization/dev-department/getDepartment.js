// lambda/organization/dev-department/getDepartment.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

exports.handler = async (event) => {
  const { departmentId } = event.pathParameters;
  console.log(`Received request to get details for department ID: ${departmentId}`);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (!departmentId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Department ID is required.' }),
    };
  }

  const getParams = {
    TableName: tableName,
    Key: marshall({
      PK: `ORG#DEPARTMENT#${departmentId}`,
      SK: 'METADATA'
    })
  };

  try {
    console.log(`Querying DynamoDB for department with PK: ORG#DEPARTMENT#${departmentId}`);
    const { Item } = await dbClient.send(new GetItemCommand(getParams));

    if (!Item) {
      console.warn(`Department with ID ${departmentId} not found.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Department not found.' }),
      };
    }

    const data = unmarshall(Item);

    // Assemble the final object, providing defaults for optional fields
    const departmentDetails = {
      departmentId: data.departmentId, 
      departmentName: decrypt(data.departmentName),
      departmentCode: data.departmentCode, 
      departmentType: data.departmentType,
      costCenter: data.costCenter, 
      departmentManager: data.departmentManager, 
      description: data.description ? decrypt(data.description) : "", 
      parentDepartment: data.parentDepartment || null, // Default to null if not present
      organizationLevel: data.organizationLevel,
      allowSubDepartments: data.allowSubDepartments, 
      maximumPositions: data.maximumPositions,
      reportingStructure: data.reportingStructure, 
      budgetControl: data.budgetControl, 
      comments: data.comments ? decrypt(data.comments) : "", 
      createdBy: data.createdBy, 
      createdAt: data.createdAt, 
    };

    console.log(`Successfully retrieved and decrypted department ID: ${departmentId}`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ department: departmentDetails }),
    };

  } catch (error) {
    console.error('An error occurred while retrieving department:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to retrieve department details.',
        error: error.message,
      }),
    };
  }
};