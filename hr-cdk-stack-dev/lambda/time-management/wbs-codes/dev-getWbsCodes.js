// lambda/organization/wbs-codes/getWbsCodes.js

const { DynamoDBClient, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getUserRole, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Helper to format the final WBS code object based on user role
const formatWbsCode = (wbsData, departmentData, userRole) => {
    const isAdmin = userRole === 'hr_admin' || userRole === 'manager_admin';

    const response = {
        wbsCode: wbsData.wbsCode,
        description: decrypt(wbsData.description),
        costCenter: wbsData.costCenter,
    };

    if (isAdmin) {
        response.department = {
            departmentId: departmentData.departmentId,
            departmentName: decrypt(departmentData.departmentName),
        };
        response.isActive = wbsData.isActive;
        response.createdBy = wbsData.createdBy;
        response.createdAt = wbsData.createdAt;
    } else {
        response.departmentName = decrypt(departmentData.departmentName);
    }
    
    return response;
};

exports.handler = async (event) => {
    console.log('Request to get WBS codes received.', event);
    
    try {
        // 1. --- RBAC and User Identification ---
        if (!isAuthorized(event, ['hr_admin', 'manager_admin', 'employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to perform this action.' }) };
        }
        const userRole = getUserRole(event);
        const employeeId = getRequestingUser(event); // This gets custom:empId

        let results = [];

        // 2. --- Role-Based Data Fetching and Filtering ---
        if (userRole === 'employee') {
            console.log(`Employee role detected for user ${employeeId}. Fetching WBS codes for their department.`);
            
            // a. Get the employee's departmentId from the Personnel table
            const { Item: contractItem } = await dbClient.send(new GetItemCommand({
                TableName: personnelTable,
                Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#CONTRACT_DETAILS' })
            }));
            const employeeDepartmentId = unmarshall(contractItem)?.department;

            if (!employeeDepartmentId) {
                console.warn(`Employee ${employeeId} is not assigned to a department. Returning empty list.`);
                return { statusCode: 200, headers: headers, body: JSON.stringify({ wbsCodes: [] }) };
            }

            // b. Scan for only active WBS codes linked to that specific department
            const scanWbsCommand = new ScanCommand({
                TableName: orgTable,
                FilterExpression: 'begins_with(PK, :pk_prefix) AND departmentId = :deptId AND isActive = :true',
                ExpressionAttributeValues: {
                    ':pk_prefix': { S: 'ORG#WBS#' },
                    ':deptId': { S: employeeDepartmentId },
                    ':true': { BOOL: true }
                },
            });

            // c. Get the single department's details for formatting
            const { Item: deptItem } = await dbClient.send(new GetItemCommand({
                TableName: orgTable,
                Key: marshall({ PK: `ORG#DEPARTMENT#${employeeDepartmentId}`, SK: 'METADATA' })
            }));

            const departmentData = deptItem ? unmarshall(deptItem) : null;
            const { Items: wbsItems } = await dbClient.send(scanWbsCommand);

            if (wbsItems && departmentData) {
                results = wbsItems.map(unmarshall).map(wbs => formatWbsCode(wbs, departmentData, userRole));
            }

        } else { // For hr_admin and manager_admin
            console.log(`Admin role detected for user ${employeeId}. Fetching all WBS codes.`);

            // Admins get all WBS codes and need all department data for mapping.
            const scanWbsCommand = new ScanCommand({
                TableName: orgTable,
                FilterExpression: 'begins_with(PK, :pk_prefix)',
                ExpressionAttributeValues: { ':pk_prefix': { S: 'ORG#WBS#' } },
            });
            const scanDeptCommand = new ScanCommand({
                TableName: orgTable,
                FilterExpression: 'begins_with(PK, :pk_prefix)',
                ExpressionAttributeValues: { ':pk_prefix': { S: 'ORG#DEPARTMENT#' } },
            });

            const [wbsResult, deptResult] = await Promise.all([
                dbClient.send(scanWbsCommand),
                dbClient.send(scanDeptCommand),
            ]);

            const departmentsMap = new Map();
            if (deptResult.Items) {
                deptResult.Items.map(unmarshall).forEach(dept => departmentsMap.set(dept.departmentId, dept));
            }
            
            const allWbsCodes = wbsResult.Items ? wbsResult.Items.map(unmarshall) : [];
            const departmentIdFilter = event.queryStringParameters?.departmentId;

            const filteredWbsCodes = allWbsCodes.filter(wbs => departmentIdFilter ? wbs.departmentId === departmentIdFilter : true);
            
            for (const wbs of filteredWbsCodes) {
                const departmentData = departmentsMap.get(wbs.departmentId);
                if (departmentData) {
                    results.push(formatWbsCode(wbs, departmentData, userRole));
                } else {
                    console.warn(`Data integrity issue: WBS code '${wbs.wbsCode}' linked to non-existent department ID '${wbs.departmentId}'.`);
                }
            }
        }
        
        console.log(`Returning ${results.length} formatted WBS codes.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ wbsCodes: results }),
        };

    } catch (error) {
        console.error('Error getting WBS codes:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to retrieve WBS codes.', error: error.message }),
        };
    }
};