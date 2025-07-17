// lambda/personnel/listEmployees.js

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

const assembleEmployee = (items) => {
    const combinedData = items.reduce((acc, item) => ({ ...acc, ...item }), {});
    
    const personalData = {
        firstName: decrypt(combinedData.firstName),
        lastName: decrypt(combinedData.lastName),
        middleName: combinedData.middleName ? decrypt(combinedData.middleName) : "",
        preferredName: combinedData.preferredName || "",
        nationalId: decrypt(combinedData.nationalId),
        dateOfBirth: combinedData.dateOfBirth,
        age: combinedData.age,
        gender: combinedData.gender,
        nationality: combinedData.nationality,
        maritalStatus: combinedData.maritalStatus,
    };

    const contactInfo = {
        email: decrypt(combinedData.email),
        phone: decrypt(combinedData.phone),
        altPhone: combinedData.altPhone ? decrypt(combinedData.altPhone) : "",
        address: decrypt(combinedData.address),
        city: decrypt(combinedData.city),
        state: decrypt(combinedData.state),
        postalCode: decrypt(combinedData.postalCode),
        country: decrypt(combinedData.country),
        emergencyContactName: combinedData.emergencyContactName ? decrypt(combinedData.emergencyContactName) : "",
        emergencyContactPhone: combinedData.emergencyContactPhone ? decrypt(combinedData.emergencyContactPhone) : "",
        emergencyContactRelationship: combinedData.emergencyContactRelationship ? decrypt(combinedData.emergencyContactRelationship) : "",
    };

    const contractDetails = {
        role: combinedData.role,
        department: combinedData.department,
        jobLevel: combinedData.jobLevel,
        contractType: combinedData.contractType,
        salaryGrade: combinedData.salaryGrade,
        salaryPay: combinedData.salaryPay,
        allowance: combinedData.allowance !== undefined ? combinedData.allowance : null,
    };
    
    return {
        employeeId: combinedData.PK.split('#')[1],
        personalData,
        contactInfo,
        contractDetails,
    };
};

exports.handler = async (event) => {
  console.log('Request to list employees with event:', event);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  
  try {
    const query = event.queryStringParameters || {};
    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    const nextToken = query.nextToken;

    const scanResult = await dbClient.send(new ScanCommand({ TableName: tableName }));
    const allItems = scanResult.Items ? scanResult.Items.map(unmarshall) : [];

    const employeesMap = new Map();
    for (const item of allItems) {
      if (!item.PK) continue;
      const pk = item.PK;
      if (!employeesMap.has(pk)) {
        employeesMap.set(pk, []);
      }
      employeesMap.get(pk).push(item);
    }
    
    const filteredEmployees = [];

    // --- THIS IS THE UPDATED LINE ---
    // Define the "allow-list" of fields that can be filtered. 'salaryGrade' is now included.
    const filterableFields = [
        'status', 'role', 'department', 'gender', 'nationality', 'maritalStatus', 
        'jobLevel', 'contractType', 'salaryGrade'
    ];
    // ---------------------------------

    const filtersToApply = { ...query };
    if (!filtersToApply.status) {
        filtersToApply.status = 'ACTIVE';
    }

    for (const items of employeesMap.values()) {
        const combinedData = items.reduce((acc, item) => ({ ...acc, ...item }), {});
        
        const isMatch = Object.entries(filtersToApply).every(([key, value]) => {
            if (!filterableFields.includes(key)) {
                return true; 
            }
            if (combinedData[key] === undefined || combinedData[key] === null) {
                return false;
            }
            return combinedData[key].toString().toLowerCase() === value.toString().toLowerCase();
        });

        if (isMatch) {
            filteredEmployees.push(items);
        }
    }

    const startIndex = nextToken ? parseInt(Buffer.from(nextToken, 'base64').toString('utf8')) : 0;
    const endIndex = startIndex + limit;
    const paginatedItems = filteredEmployees.slice(startIndex, endIndex);
    const newNextToken = endIndex < filteredEmployees.length 
      ? Buffer.from(endIndex.toString()).toString('base64') 
      : null;
    const results = paginatedItems.map(employeeItems => assembleEmployee(employeeItems));

    console.log(`Returning ${results.length} of ${filteredEmployees.length} filtered employees.`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        employees: results,
        count: results.length,
        nextToken: newNextToken,
      }),
    };

  } catch (error) {
    console.error('Error listing employees:', error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Failed to list employees', error: error.message }),
    };
  }
};