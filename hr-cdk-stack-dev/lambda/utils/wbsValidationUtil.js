// lambda/utils/wbsValidationUtil.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

/**
 * Validates that a given WBS code is valid, active, and assigned to the employee's department.
 * @param {string} wbsCode The WBS code to validate.
 * @param {string} employeeId The ID of the employee attempting to use the code.
 * @throws {Error} If validation fails at any step.
 * @returns {Promise<boolean>} True if validation is successful.
 */
async function validateWbsCodeForEmployee(wbsCode, employeeId) {
    console.log(`Validating if WBS code '${wbsCode}' can be used by employee '${employeeId}'...`);
    
    // Step 1: Get the WBS code's details
    const { Item: wbsItem } = await dbClient.send(new GetItemCommand({
        TableName: orgTable,
        Key: marshall({ PK: `ORG#WBS#${wbsCode}`, SK: 'METADATA' })
    }));
    if (!wbsItem) throw new Error(`The provided WBS code '${wbsCode}' does not exist.`);
    
    const wbsData = unmarshall(wbsItem);
    if (!wbsData.isActive) throw new Error(`The provided WBS code '${wbsCode}' is not active.`);

    // Step 2: Get the employee's departmentId
    const { Item: contractItem } = await dbClient.send(new GetItemCommand({
        TableName: personnelTable,
        Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#CONTRACT_DETAILS' })
    }));
    if (!contractItem) throw new Error(`Could not find contract details for employee '${employeeId}'.`);
    
    const employeeDepartmentId = unmarshall(contractItem).department;

    // Step 3: Compare the department IDs
    if (wbsData.departmentId !== employeeDepartmentId) {
        throw new Error(`You do not have permission to use WBS code '${wbsCode}'. It is not assigned to your department.`);
    }

    console.log("WBS code validation successful.");
    return true;
}

module.exports = {
    validateWbsCodeForEmployee
};