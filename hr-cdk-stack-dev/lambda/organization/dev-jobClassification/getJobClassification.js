// lambda/organization/dev-jobClassification/getJobClassification.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

exports.handler = async (event) => {
  const { jobClassificationId } = event.pathParameters;
  console.log(`Received request to get job classification ID: ${jobClassificationId}`);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (!jobClassificationId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Job Classification ID is required.' }),
    };
  }

  const getParams = {
    TableName: tableName,
    Key: marshall({
      PK: `ORG#JOB_CLASSIFICATION#${jobClassificationId}`,
      SK: 'METADATA',
    }),
  };

  try {
    console.log(`Getting job classification from DynamoDB with PK: ${getParams.Key.PK.S}`);
    const { Item } = await dbClient.send(new GetItemCommand(getParams));

    if (!Item) {
      console.warn(`No job classification found for ID: ${jobClassificationId}.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Job classification not found.' }),
      };
    }

    const data = unmarshall(Item);

    // --- Decrypt and Structure the Final Response ---
    const jobClassificationDetails = {
      jobClassificationId: data.jobClassificationId,
      jobFamily: data.jobFamily,
      jobTitle: data.jobTitle,
      payScale: data.payScale,
      responsibilities: data.responsibilities ? decrypt(data.responsibilities) : "", 
      createdBy: data.createdBy,
      createdAt: data.createdAt,
    };
    
    console.log(`Successfully retrieved and decrypted data for job classification ID: ${jobClassificationId}`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ jobClassification: jobClassificationDetails }),
    };

  } catch (error) {
    console.error('An error occurred while getting job classification details:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to retrieve job classification details.',
        error: error.message,
      }),
    };
  }
};