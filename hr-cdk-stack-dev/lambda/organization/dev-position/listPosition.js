// lambda/organization/dev-position/listPosition.js

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

const assembleAndDecryptPosition = (item) => {
    // This is the same helper logic from getPosition.js
    return {
        positionId: item.positionId,
        positionTitle: item.positionTitle,
        positionCode: item.positionCode,
        reportsTo: item.reportsTo,
        salaryGrade: item.salaryGrade,
        departmentId: item.departmentId || null,
        positionLevel: item.positionLevel || "",
        employmentType: item.employmentType || "",
        positionDescription: item.positionDescription ? decrypt(item.positionDescription) : "",
        education: item.education || "",
        skills: item.skills || [],
        certifications: item.certifications || [],
        competencyLevel: item.competencyLevel || "",
        comments: item.comments ? decrypt(item.comments) : "",
        createdBy: item.createdBy,
        createdAt: item.createdAt,
    };
};

exports.handler = async (event) => {
    console.log('Request to list positions with event:', event);

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

        // Step 1: Scan for ALL position items efficiently.
        const scanParams = {
            TableName: tableName,
            FilterExpression: 'begins_with(PK, :pk_prefix) AND SK = :sk',
            ExpressionAttributeValues: {
                ':pk_prefix': { S: 'ORG#POSITION#' },
                ':sk': { S: 'METADATA' }
            }
        };

        const scanResult = await dbClient.send(new ScanCommand(scanParams));
        const allPositions = scanResult.Items ? scanResult.Items.map(unmarshall) : [];

        // Step 2: Filter the results in memory.
        const filterableFields = [
            'positionTitle', 'positionCode', 'departmentId', 'positionLevel',
            'employmentType', 'reportsTo', 'education', 'skills',
            'certifications', 'salaryGrade', 'competencyLevel', 'createdBy', 'createdAt'
        ];

        const filtered = allPositions.filter(position => {
            return Object.entries(query).every(([key, value]) => {
                if (!filterableFields.includes(key)) return true;
                if (position[key] === undefined || position[key] === null) return false;

                if (key === 'skills' || key === 'certifications') {
                    return position[key].some(item => 
                        item.toLowerCase() === value.toLowerCase()
                    );
                }
                
                return position[key].toString().toLowerCase() === value.toLowerCase();
            });
        });

        // Step 3: Paginate the filtered results.
        const startIndex = nextToken ? parseInt(Buffer.from(nextToken, 'base64').toString('utf8')) : 0;
        const endIndex = startIndex + limit;
        const paginatedItems = filtered.slice(startIndex, endIndex);
        const newNextToken = endIndex < filtered.length 
          ? Buffer.from(endIndex.toString()).toString('base64') 
          : null;

        // Step 4: Assemble and decrypt the final page of results.
        const results = paginatedItems.map(assembleAndDecryptPosition);

        console.log(`Returning ${results.length} of ${filtered.length} filtered positions.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                positions: results,
                count: results.length,
                nextToken: newNextToken,
            }),
        };

    } catch (error) {
        console.error('Error listing positions:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to list positions', error: error.message }),
        };
    }
};