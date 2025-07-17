// lambda/personnel/dev-employee/createEmployee.js

const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

const personalDataRequiredFields = [
  'firstName', 'lastName', 'nationalId', 'dateOfBirth', 'age', 
  'gender', 'nationality', 'maritalStatus'
];
const contactInfoRequiredFields = [
  'email', 'phone', 'address', 'city', 'state', 'postalCode', 'country'
];
const contractDetailsRequiredFields = [
  'role', 'department', 'jobLevel', 'contractType', 'salaryGrade', 'salaryPay'
];

exports.handler = async (event) => {
  console.log('Received request to create a new employee.');

  // Define CORS headers for this POST endpoint
  const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  try {
    const body = JSON.parse(event.body);

    const allRequiredFields = [
      ...personalDataRequiredFields, 
      ...contactInfoRequiredFields, 
      ...contractDetailsRequiredFields
    ];
    const validationResult = validateBody(body, allRequiredFields);

    if (!validationResult.isValid) {
      console.warn('Validation failed:', validationResult.message);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ message: validationResult.message }),
      };
    }
    console.log('Input validation passed.');

    const employeeId = uuidv4();
    const pk = `EMPLOYEE#${employeeId}`;
    console.log(`Generated new employee ID: ${employeeId}`);

    // Personal Data Item
    const personalDataItem = {
      PK: pk,
      SK: 'SECTION#PERSONAL_DATA',
      firstName: encrypt(body.firstName),
      lastName: encrypt(body.lastName),
      middleName: body.middleName ? encrypt(body.middleName) : undefined,
      preferredName: body.preferredName,
      nationalId: encrypt(body.nationalId),
      dateOfBirth: body.dateOfBirth,
      age: body.age,
      gender: body.gender,
      nationality: body.nationality,
      maritalStatus: body.maritalStatus,
      status: 'ACTIVE',
    };

    // Contact Info Item
    const contactInfoItem = {
      PK: pk,
      SK: 'SECTION#CONTACT_INFO',
      email: encrypt(body.email),
      phone: encrypt(body.phone),
      altPhone: body.altPhone ? encrypt(body.altPhone) : undefined,
      address: encrypt(body.address),
      city: encrypt(body.city),
      state: encrypt(body.state),
      postalCode: encrypt(body.postalCode),
      country: encrypt(body.country),
      emergencyContactName: body.emergencyContactName ? encrypt(body.emergencyContactName) : undefined,
      emergencyContactPhone: body.emergencyContactPhone ? encrypt(body.emergencyContactPhone) : undefined,
      emergencyContactRelationship: body.emergencyContactRelationship ? encrypt(body.emergencyContactRelationship) : undefined,
    };

    // Contract Details Item
    const contractDetailsItem = {
      PK: pk,
      SK: 'SECTION#CONTRACT_DETAILS',
      role: body.role,
      department: body.department,
      jobLevel: body.jobLevel,
      contractType: body.contractType,
      salaryGrade: body.salaryGrade,
      salaryPay: body.salaryPay,
      allowance: body.allowance,
    };

    // --- THIS IS THE FIX ---
    // Pass the { removeUndefinedValues: true } option to marshall to ignore optional fields
    // that are not present in the request body.
    const marshallOptions = {
        removeUndefinedValues: true,
    };

    const transactionParams = {
      TransactItems: [
        { Put: { TableName: tableName, Item: marshall(personalDataItem, marshallOptions) } },
        { Put: { TableName: tableName, Item: marshall(contactInfoItem, marshallOptions) } },
        { Put: { TableName: tableName, Item: marshall(contractDetailsItem, marshallOptions) } },
      ],
    };
    // ----------------------

    console.log('Executing transaction to create employee records...');
    await dbClient.send(new TransactWriteItemsCommand(transactionParams));
    console.log(`Successfully created employee with ID: ${employeeId}`);

    return {
      statusCode: 201,
      headers: headers,
      body: JSON.stringify({
        message: 'Employee created successfully.',
        employeeId: employeeId,
      }),
    };

  } catch (error) {
    console.error('An error occurred during employee creation:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        message: 'Internal Server Error. Failed to create employee.',
        error: error.message,
      }),
    };
  }
};