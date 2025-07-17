// lambda/personnel/dev-employee/getEmployee.js

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

/**
 * A helper function to assemble and decrypt the employee data from DynamoDB items
 * into a structured, nested object. Ensures optional fields are always present
 * with a default empty value (e.g., "" or null) for a consistent response shape.
 * @param {Array<Object>} items - The array of items returned from the DynamoDB query.
 * @returns {Object | null} A single, nested employee object, or null.
 */
const assembleAndDecryptEmployee = (items) => {
  if (!items || items.length === 0) {
    return null;
  }

  // Combine all items into a single flat object for easy access
  const combinedData = items.reduce((acc, item) => ({ ...acc, ...item }), {});

  // --- BUILD NESTED OBJECTS, PROVIDING DEFAULTS FOR OPTIONAL FIELDS ---

  const personalData = {
    // Required fields
    firstName: decrypt(combinedData.firstName),
    lastName: decrypt(combinedData.lastName),
    middleName: combinedData.middleName ? decrypt(combinedData.middleName) : "", // Plaintext optional field
    preferredName: combinedData.preferredName || "", // Plaintext optional field
    nationalId: decrypt(combinedData.nationalId),
    dateOfBirth: combinedData.dateOfBirth,
    age: combinedData.age,
    gender: combinedData.gender,
    nationality: combinedData.nationality,
    maritalStatus: combinedData.maritalStatus,
  };

  const contactInfo = {
    // Required fields
    email: decrypt(combinedData.email),
    phone: decrypt(combinedData.phone),
    altPhone: combinedData.altPhone ? decrypt(combinedData.altPhone) : "", // Optional field
    address: decrypt(combinedData.address),
    city: decrypt(combinedData.city),
    state: decrypt(combinedData.state),
    postalCode: decrypt(combinedData.postalCode),
    country: decrypt(combinedData.country),
    emergencyContact: {
        name: combinedData.emergencyContactName ? decrypt(combinedData.emergencyContactName) : "",
        phone: combinedData.emergencyContactPhone ? decrypt(combinedData.emergencyContactPhone) : "",
        relationship: combinedData.emergencyContactRelationship ? decrypt(combinedData.emergencyContactRelationship) : "",
    }
  };

  const contractDetails = {
    // Required fields
    role: combinedData.role,
    department: combinedData.department,
    jobLevel: combinedData.jobLevel,
    contractType: combinedData.contractType,
    salaryGrade: combinedData.salaryGrade,
    salaryPay: combinedData.salaryPay,
    allowance: combinedData.allowance !== undefined ? combinedData.allowance : null, // Optional field with a null default to distinguish from a value of 0
  };

  // --- ASSEMBLE THE FINAL, TOP-LEVEL OBJECT ---
  const finalResponse = {
    employee: {
      personalData,
      contactInfo,
      contractDetails,
    }
  };

  return finalResponse;
};

// The main handler function remains unchanged as its logic is already correct.
exports.handler = async (event) => {
  const { employeeId } = event.pathParameters;
  console.log(`Received request to get details for employee ID: ${employeeId}`);

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

  const queryParams = {
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': { S: pk },
    },
  };

  try {
    console.log(`Querying DynamoDB for employee with PK: ${pk}`);
    const { Items } = await dbClient.send(new QueryCommand(queryParams));

    if (!Items || Items.length === 0) {
      console.warn(`No records found for employee ID: ${employeeId}.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found.' }),
      };
    }

    const unmarshalledItems = Items.map(item => unmarshall(item));

    const personalDataItem = unmarshalledItems.find(item => item.SK === 'SECTION#PERSONAL_DATA');

    if (!personalDataItem || personalDataItem.status !== 'ACTIVE') {
      console.warn(`Employee ID: ${employeeId} is not active or personal data is missing.`);
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'Employee not found.' }),
      };
    }
    console.log(`Employee ID: ${employeeId} is active. Proceeding with data assembly.`);

    const employeeDetails = assembleAndDecryptEmployee(unmarshalledItems);
    
    console.log(`Successfully retrieved and decrypted data for employee ID: ${employeeId}`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify(employeeDetails),
    };

  } catch (error) {
    console.error('An error occurred while getting employee details:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to retrieve employee details.',
        error: error.message,
      }),
    };
  }
};