// lambda/organization/dev-jobClassification/listJobClassification.js

const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

// Helper to assemble and decrypt job classification
const assembleJobClassification = (item) => {
    return {
        jobClassificationId: item.jobClassificationId,
        jobFamily: item.jobFamily,
        jobTitle: item.jobTitle,
        payScale: item.payScale,
        responsibilities: item.responsibilities ? decrypt(item.responsibilities) : '',
        createdBy: item.createdBy,
        createdAt: item.createdAt,
    };
};

exports.handler = async (event) => {
    console.log('Request to list job classifications with event:', event);

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

        // Step 1: Scan for ALL job classification items efficiently
        const scanResult = await dbClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'begins_with(PK, :pk_prefix) AND SK = :sk',
            ExpressionAttributeValues: {
                ':pk_prefix': { S: 'ORG#JOB_CLASSIFICATION#' },
                ':sk': { S: 'METADATA' }
            }
        }));
        const allItems = scanResult.Items ? scanResult.Items.map(unmarshall) : [];

        // Step 2: Filter the results in memory
        const filterableFields = ['jobFamily', 'jobTitle', 'payScale', 'createdBy', 'createdAt'];

        const filtered = allItems.filter(item => {
            return Object.entries(query).every(([key, value]) => {
                if (!filterableFields.includes(key)) return true;
                if (item[key] === undefined || item[key] === null) return false;
                return item[key].toString().toLowerCase() === value.toLowerCase();
            });
        });

        // Step 3: Paginate the filtered results
        const startIndex = nextToken ? parseInt(Buffer.from(nextToken, 'base64').toString('utf8')) : 0;
        const endIndex = startIndex + limit;
        const paginatedItems = filtered.slice(startIndex, endIndex);
        const newNextToken = endIndex < filtered.length ? Buffer.from(endIndex.toString()).toString('base64') : null;

        // Step 4: Assemble and decrypt the final page
        const results = paginatedItems.map(assembleJobClassification);

        console.log(`Returning ${results.length} of ${filtered.length} filtered job classifications.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                jobClassifications: results,
                count: results.length,
                nextToken: newNextToken,
            }),
        };
    } catch (error) {
        console.error('Error listing job classifications:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to list job classifications', error: error.message }),
        };
    }
};