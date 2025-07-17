// lambda/personnel/dev-contactInfo/updateContactInfo.js

const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

// Required fields for just this section
const requiredFields = [
  'email', 'phone', 'address', 'city', 'state', 'postalCode', 'country'
];

exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Request to update contact info for employee ID: ${employeeId}`);

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
    
    // Map required fields
    const requiredFieldsToUpdate = {
        email: encrypt(body.email),
        phone: encrypt(body.phone),
        address: encrypt(body.address),
        city: encrypt(body.city),
        state: encrypt(body.state),
        postalCode: encrypt(body.postalCode),
        country: encrypt(body.country),
    };

    // Handle optional fields by checking for key existence.
    const optionalFieldsToUpdate = {};
    if (body.hasOwnProperty('altPhone')) {
        optionalFieldsToUpdate.altPhone = encrypt(body.altPhone);
    }
    if (body.hasOwnProperty('emergencyContactName')) {
        optionalFieldsToUpdate.emergencyContactName = encrypt(body.emergencyContactName);
    }
    if (body.hasOwnProperty('emergencyContactPhone')) {
        optionalFieldsToUpdate.emergencyContactPhone = encrypt(body.emergencyContactPhone);
    }
    if (body.hasOwnProperty('emergencyContactRelationship')) {
        optionalFieldsToUpdate.emergencyContactRelationship = encrypt(body.emergencyContactRelationship);
    }

    const fieldsToUpdate = { ...requiredFieldsToUpdate, ...optionalFieldsToUpdate };

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
        // a. ConditionCheck: Ensure the employee is active before proceeding.
        {
          ConditionCheck: {
            TableName: tableName,
            Key: marshall({ PK: pk, SK: 'SECTION#PERSONAL_DATA' }),
            ConditionExpression: '#status = :activeStatus',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({ ':activeStatus': 'ACTIVE' }),
          }
        },
        // b. Update: Apply the changes to the contact info item.
        {
          Update: {
            TableName: tableName,
            Key: marshall({ PK: pk, SK: 'SECTION#CONTACT_INFO' }),
            UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: marshall(expressionAttributeValues),
          }
        }
      ]
    };

    console.log(`Executing transaction to update contact info for ${employeeId}...`);
    await dbClient.send(new TransactWriteItemsCommand(transactionParams));
    console.log(`Successfully updated contact info for ${employeeId}.`);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ message: 'Contact information updated successfully.' }),
    };

  } catch (error) {
    if (error.name === 'TransactionCanceledException') {
      console.warn(`Update failed for ${employeeId}, employee not found or not active.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found or is not active.' }),
      };
    }
    console.error('Error updating contact info:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to update contact info.', error: error.message }),
    };
  }
};