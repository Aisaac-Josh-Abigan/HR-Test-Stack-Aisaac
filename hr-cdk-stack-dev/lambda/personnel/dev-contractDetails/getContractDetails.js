// lambda/personnel/dev-contractDetails/getContractDetails.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Request to get contract details for employee ID: ${employeeId}`);

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
    console.log(`Employee ${employeeId} is active. Proceeding to fetch contract details.`);

    // 2. --- If active, fetch the Contract Details item ---
    const contractDetailsKey = { PK: pk, SK: 'SECTION#CONTRACT_DETAILS' };
    const getCommand = new GetItemCommand({
      TableName: tableName,
      Key: marshall(contractDetailsKey),
    });

    const { Item } = await dbClient.send(getCommand);

    if (!Item) {
      console.error(`Data inconsistency: Active employee ${employeeId} is missing contract details.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Contract details not found for this employee.' }),
      };
    }

    const contractDetails = unmarshall(Item);

    // 3. --- Structure the Final Response ---
    // No decryption needed for this section as all fields are plaintext
    const structuredData = {
      role: contractDetails.role,
      department: contractDetails.department,
      jobLevel: contractDetails.jobLevel,
      contractType: contractDetails.contractType,
      salaryGrade: contractDetails.salaryGrade,
      salaryPay: contractDetails.salaryPay,
      // Ensure optional field has a default value for consistent response shape
      allowance: contractDetails.allowance !== undefined ? contractDetails.allowance : null,
    };

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ contractDetails: structuredData }),
    };

  } catch (error) {
    console.error('Error getting contract details:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to retrieve contract details.', error: error.message }),
    };
  }
};