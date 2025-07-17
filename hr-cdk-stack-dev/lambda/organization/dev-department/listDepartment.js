// lambda/organization/dev-department/listDepartment.js

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Helper to assemble and decrypt a department object
const assembleDepartment = (item) => {
    return {
        departmentId: item.departmentId,
        departmentName: decrypt(item.departmentName),
        departmentCode: item.departmentCode,
        departmentType: item.departmentType,
        costCenter: item.costCenter,
        departmentManager: item.departmentManager,
        description: item.description ? decrypt(item.description) : "",
        parentDepartment: item.parentDepartment || null,
        organizationLevel: item.organizationLevel,
        allowSubDepartments: item.allowSubDepartments,
        maximumPositions: item.maximumPositions,
        reportingStructure: item.reportingStructure,
        budgetControl: item.budgetControl,
        comments: item.comments ? decrypt(item.comments) : "",
        createdBy: item.createdBy,
        createdAt: item.createdAt,
    };
};

exports.handler = async (event) => {
    console.log('Request to list departments received with event:', event);

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

        // Step 1: Scan for ALL department items efficiently
        const scanParams = {
            TableName: tableName,
            FilterExpression: 'begins_with(PK, :pk_prefix) AND SK = :sk',
            ExpressionAttributeValues: {
                ':pk_prefix': { S: 'ORG#DEPARTMENT#' },
                ':sk': { S: 'METADATA' }
            }
        };

        const scanResult = await dbClient.send(new ScanCommand(scanParams));
        const allDepartments = scanResult.Items ? scanResult.Items.map(unmarshall) : [];

        // Step 2: Filter the results in memory
        const filterableFields = [
            'departmentCode', 'departmentType', 'costCenter', 'departmentManager',
            'parentDepartment', 'organizationLevel', 'allowSubDepartments',
            'maximumPositions', 'reportingStructure', 'budgetControl',
            'createdBy', 'createdAt'
        ];

        const filtered = allDepartments.filter(department => {
            return Object.entries(query).every(([key, value]) => {
                if (!filterableFields.includes(key)) return true; // Ignore non-filterable params
                if (department[key] === undefined || department[key] === null) return false;
                
                // Case-insensitive exact match
                return department[key].toString().toLowerCase() === value.toLowerCase();
            });
        });

        // Step 3: Paginate the filtered results
        const startIndex = nextToken ? parseInt(Buffer.from(nextToken, 'base64').toString('utf8')) : 0;
        const endIndex = startIndex + limit;
        const paginatedItems = filtered.slice(startIndex, endIndex);
        const newNextToken = endIndex < filtered.length ? Buffer.from(endIndex.toString()).toString('base64') : null;

        // Step 4: Assemble and decrypt the final page
        const results = paginatedItems.map(assembleDepartment);

        console.log(`Returning ${results.length} of ${filtered.length} filtered departments.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                departments: results,
                count: results.length,
                nextToken: newNextToken,
            }),
        };

    } catch (error) {
        console.error('Error listing departments:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to list departments', error: error.message })
        };
    }
};