// lambda/personnel/dev-contractDetails/updateContractDetails.js

const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

// Required fields for just this section
const requiredFields = [
  'role', 'department', 'jobLevel', 'contractType', 'salaryGrade', 'salaryPay'
];

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Request to update contract details for employee ID: ${employeeId}`);

  // Define CORS headers for this PUT endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  };

  if (!employeeId) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'Employee ID is required.' }),
    };
  }

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
    console.log(`Input validation passed for ${employeeId}.`);

    // 2. --- Dynamically Build Update Expression ---
    const updateExpressionParts = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};
    
    // All fields in this section are plaintext
    const fieldsToUpdate = {
      role: body.role,
      department: body.department,
      jobLevel: body.jobLevel,
      contractType: body.contractType,
      salaryGrade: body.salaryGrade,
      salaryPay: body.salaryPay,
    };
    
    // Handle optional 'allowance' field by checking for key existence
    if (body.hasOwnProperty('allowance')) {
        fieldsToUpdate.allowance = body.allowance;
    }

    for (const [field, value] of Object.entries(fieldsToUpdate)) {
        const valueKey = `:${field}`;
        const nameKey = `#${field}`;
        updateExpressionParts.push(`${nameKey} = ${valueKey}`);
        expressionAttributeValues[valueKey] = value;
        expressionAttributeNames[nameKey] = field;
    }

    // 3. --- Construct and Execute Atomic Transaction ---
    const pk = `EMPLOYEE#${employeeId}`;
    const transactionParams = {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: marshall({ PK: pk, SK: 'SECTION#PERSONAL_DATA' }),
            ConditionExpression: '#status = :activeStatus',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({ ':activeStatus': 'ACTIVE' }),
          }
        },
        {
          Update: {
            TableName: tableName,
            Key: marshall({ PK: pk, SK: 'SECTION#CONTRACT_DETAILS' }),
            UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: marshall(expressionAttributeValues),
          }
        }
      ]
    };

    console.log(`Executing transaction to update contract details for ${employeeId}...`);
    await dbClient.send(new TransactWriteItemsCommand(transactionParams));
    console.log(`Successfully updated contract details for ${employeeId}.`);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ message: 'Contract details updated successfully.' }),
    };

  } catch (error) {
    if (error.name === 'TransactionCanceledException') {
      console.warn(`Update failed for ${employeeId}, employee not found or not active.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found.' }),
      };
    }
    console.error('Error updating contract details:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to update contract details.', error: error.message }),
    };
  }
};