// lambda/organization/dev-orgUnit/getOrgUnit.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

exports.handler = async (event) => {
  const { unitId } = event.pathParameters;
  console.log(`Received request to get org unit ID: ${unitId}`);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (!unitId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Organizational Unit ID is required.' }),
    };
  }

  const getParams = {
    TableName: tableName,
    Key: marshall({
      PK: `ORG#ORG_UNIT#${unitId}`,
      SK: 'METADATA',
    }),
  };

  try {
    console.log(`Querying DynamoDB for PK: ${getParams.Key.PK.S}`);
    const { Item } = await dbClient.send(new GetItemCommand(getParams));

    if (!Item) {
      console.warn(`No org unit found for ID: ${unitId}`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Organizational Unit not found.' }),
      };
    }

    const data = unmarshall(Item);

    // --- Decrypt and Structure the Final Response ---
    const orgUnitDetails = {
        unitId: data.unitId,
        departmentId: data.departmentId,
        unitName: decrypt(data.unitName),
        description: decrypt(data.description),
        effectiveDate: data.effectiveDate,
        costCenterInfo: data.costCenterInfo,
        createdBy: data.createdBy,
        createdAt: data.createdAt,
    };

    console.log(`Successfully retrieved org unit: ${unitId}`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ orgUnit: orgUnitDetails }),
    };

  } catch (error) {
    console.error('Error fetching org unit:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to retrieve org unit.',
        error: error.message,
      }),
    };
  }
};