// lambda/personnel/searchEmployees.js

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.PERSONNEL_TABLE_NAME;

/**
 * A helper to assemble and decrypt the complete employee object from a list of items.
 * This version ensures the output is strictly within a 3-level nesting limit.
 * @param {Array<Object>} items - All items belonging to a single employee.
 * @returns {Object} The structured employee object.
 */
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
        // --- NESTING FIX: Emergency contact fields are flattened ---
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
  const query = event.queryStringParameters || {};
  console.log('Search request received with criteria:', query);

  // Define CORS headers for this GET endpoint
  const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (Object.keys(query).length === 0) {
    return {
      statusCode: 400,
      headers: headers,
      body: JSON.stringify({ message: 'At least one search parameter is required.' }),
    };
  }

  try {
    // Step 1: Scan the ENTIRE table to fetch all items.
    const scanResult = await dbClient.send(new ScanCommand({ TableName: tableName }));
    const allItems = scanResult.Items ? scanResult.Items.map(unmarshall) : [];

    // Step 2: Group all items by employee ID to create logical employee records.
    const employeesMap = new Map();
    for (const item of allItems) {
      if (!item.PK) continue;
      const pk = item.PK;
      if (!employeesMap.has(pk)) {
        employeesMap.set(pk, []);
      }
      employeesMap.get(pk).push(item);
    }
    
    // Step 3: Filter these complete, logical records in memory using "contains" logic.
    const matchedPks = [];
    for (const [pk, items] of employeesMap.entries()) {
      const combinedData = items.reduce((acc, item) => ({ ...acc, ...item }), {});

      if (combinedData.status !== 'ACTIVE') {
        continue;
      }
      
      /**
       * IMPORTANT SEARCH LOGIC:
       * This search is performed in-memory after fetching all records.
       * It iterates through the query parameters provided by the user.
       * For a successful match, the search value must be a substring of the data in the database.
       * The comparison is case-insensitive.
       * 
       * NOTE: This search will ONLY work successfully on plaintext (non-encrypted) fields.
       * Attempting to search an encrypted field (e.g., 'firstName', 'email') will fail because
       * the search value will be compared against the encrypted gibberish, not the decrypted text.
       */
      const isMatch = Object.entries(query).every(([key, value]) => {
        if (combinedData[key] === undefined || combinedData[key] === null) {
          return false;
        }
        return combinedData[key].toString().toLowerCase().includes(value.toString().toLowerCase());
      });

      if (isMatch) {
        matchedPks.push(pk);
      }
    }
    
    if (matchedPks.length === 0) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ message: 'No matching employees found.' }),
      };
    }

    // Step 4: Assemble the final, decrypted response for ONLY the matching employees.
    const finalResults = matchedPks.map(pk => {
      const employeeItems = employeesMap.get(pk);
      return assembleEmployee(employeeItems);
    });

    console.log(`In-memory filter found ${finalResults.length} employees.`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ employees: finalResults }),
    };

  } catch (err) {
    console.error('searchEmployees error:', err);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ message: 'Search failed', error: err.message }),
    };
  }
};