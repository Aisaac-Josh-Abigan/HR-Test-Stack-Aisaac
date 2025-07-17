// lambda/personnel/dev-personalData/getPersonalData.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Request to get personal data for employee ID: ${employeeId}`);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (!employeeId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Employee ID is required.' }),
    };
  }

  const key = {
    PK: `EMPLOYEE#${employeeId}`,
    SK: 'SECTION#PERSONAL_DATA',
  };

  const command = new GetItemCommand({
    TableName: tableName,
    Key: marshall(key),
  });

  try {
    const { Item } = await dbClient.send(command);

    if (!Item) {
      console.warn(`Personal data not found for employee ID: ${employeeId}.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Personal data not found for this employee.' }),
      };
    }

    const personalData = unmarshall(Item);

    // --- Enforce "Active Check" Business Rule ---
    if (personalData.status !== 'ACTIVE') {
      console.warn(`Employee ID: ${employeeId} is not active.`);
      return {
        statusCode: 404, // Treat inactive as not found
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found.' }),
      };
    }
    console.log(`Employee ${employeeId} is active. Decrypting personal data.`);

    // --- Decrypt and Structure the Final Response ---
    const decryptedData = {
      firstName: decrypt(personalData.firstName),
      lastName: decrypt(personalData.lastName),
      middleName: personalData.middleName ? decrypt(personalData.middleName) : "",
      preferredName: personalData.preferredName || "",
      nationalId: decrypt(personalData.nationalId),
      dateOfBirth: personalData.dateOfBirth,
      age: personalData.age,
      gender: personalData.gender,
      nationality: personalData.nationality,
      maritalStatus: personalData.maritalStatus,
    };

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ personalData: decryptedData }),
    };

  } catch (error) {
    console.error('Error getting personal data:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to retrieve personal data.', error: error.message }),
    };
  }
};