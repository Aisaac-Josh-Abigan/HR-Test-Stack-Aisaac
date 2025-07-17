// lambda/personnel/dev-employee/deleteEmployee.js

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Received request to archive employee ID: ${employeeId}`);

  // Define CORS headers for this DELETE endpoint
  const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
  };

  // 1. --- Input Validation ---
  if (!employeeId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Employee ID is required in the path.' }),
    };
  }

  // 2. --- Construct Update Parameters ---
  // This command targets the specific personal data item and updates only its status.
  const params = {
    TableName: tableName,
    Key: marshall({
      PK: `EMPLOYEE#${employeeId}`,
      SK: 'SECTION#PERSONAL_DATA', // The 'status' attribute lives here
    }),
    // The UpdateExpression sets the 'status' attribute to the new value 'INACTIVE'.
    UpdateExpression: 'SET #status = :inactiveStatus',
    // The ConditionExpression ensures this operation only succeeds if the current status is 'ACTIVE'.
    // This prevents archiving an already archived user or a non-existent one.
    ConditionExpression: '#status = :activeStatus',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: marshall({
      ':inactiveStatus': 'INACTIVE',
      ':activeStatus': 'ACTIVE',
    }),
    // We don't need the old or new values back, so we set ReturnValues to NONE for efficiency.
    ReturnValues: 'NONE',
  };

  try {
    // 3. --- Execute the Atomic Update ---
    console.log(`Executing update to archive employee ${employeeId}...`);
    await dbClient.send(new UpdateItemCommand(params));
    console.log(`Successfully archived employee with ID: ${employeeId}`);

    // 4. --- Return Success Response ---
    // A 204 No Content response is often appropriate for a successful DELETE action
    // where there's nothing to return. A 200 with a message is also fine.
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ message: 'Employee archived successfully.' }),
    };

  } catch (error) {
    // This specific error name means our ConditionExpression failed.
    if (error.name === 'ConditionalCheckFailedException') {
      console.warn(`Attempted to archive employee ${employeeId}, but they are not active or do not exist.`);
      // Return a 404 to the client. This is standard practice.
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found or is already inactive.' }),
      };
    }

    // Handle any other unexpected errors.
    console.error(`An error occurred while archiving employee ID ${employeeId}:`, error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to archive employee.',
        error: error.message,
      }),
    };
  }
};