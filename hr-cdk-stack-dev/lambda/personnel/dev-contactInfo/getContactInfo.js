// lambda/personnel/dev-contactInfo/getContactInfo.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Request to get contact info for employee ID: ${employeeId}`);

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

  const pk = `EMPLOYEE#${employeeId}`;

  try {
    // 1. --- Perform "Active Check" on the Personal Data item first ---
    const personalDataKey = { PK: pk, SK: 'SECTION#PERSONAL_DATA' };
    const checkCommand = new GetItemCommand({
      TableName: tableName,
      Key: marshall(personalDataKey),
      ProjectionExpression: '#status', // Only fetch the status attribute for efficiency
      ExpressionAttributeNames: { '#status': 'status' },
    });

    const { Item: personalDataItem } = await dbClient.send(checkCommand);

    if (!personalDataItem || unmarshall(personalDataItem).status !== 'ACTIVE') {
      console.warn(`Employee ${employeeId} not found or is not active.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found.' }),
      };
    }
    console.log(`Employee ${employeeId} is active. Proceeding to fetch contact info.`);

    // 2. --- If active, fetch the Contact Info item ---
    const contactInfoKey = { PK: pk, SK: 'SECTION#CONTACT_INFO' };
    const getCommand = new GetItemCommand({
      TableName: tableName,
      Key: marshall(contactInfoKey),
    });

    const { Item } = await dbClient.send(getCommand);

    if (!Item) {
      // This case might happen if data is inconsistent, but we handle it gracefully.
      console.error(`Data inconsistency: Active employee ${employeeId} is missing contact info.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Contact information not found for this employee.' }),
      };
    }

    const contactInfo = unmarshall(Item);

    // 3. --- Decrypt and Structure the Final Response ---
    const decryptedData = {
      email: decrypt(contactInfo.email),
      phone: decrypt(contactInfo.phone),
      altPhone: contactInfo.altPhone ? decrypt(contactInfo.altPhone) : "",
      address: decrypt(contactInfo.address),
      city: decrypt(contactInfo.city),
      state: decrypt(contactInfo.state),
      postalCode: decrypt(contactInfo.postalCode),
      country: decrypt(contactInfo.country),
      emergencyContact: {
        name: contactInfo.emergencyContactName ? decrypt(contactInfo.emergencyContactName) : "",
        phone: contactInfo.emergencyContactPhone ? decrypt(contactInfo.emergencyContactPhone) : "",
        relationship: contactInfo.emergencyContactRelationship ? decrypt(contactInfo.emergencyContactRelationship) : "",
      }
    };

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ contactInfo: decryptedData }),
    };

  } catch (error) {
    console.error('Error getting contact info:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to retrieve contact info.', error: error.message }),
    };
  }
};