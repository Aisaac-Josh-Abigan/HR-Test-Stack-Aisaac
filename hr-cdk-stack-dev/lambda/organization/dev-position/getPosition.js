// lambda/organization/dev-position/getPosition.js

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const tableName = process.env.ORGANIZATIONAL_TABLE_NAME;

exports.handler = async (event) => {
    const { positionId } = event.pathParameters;
    console.log(`Request to get position with ID: ${positionId}`);

    // Define CORS headers for this GET endpoint
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    if (!positionId) {
        return {
            statusCode: 400,
            headers: headers,
            body: JSON.stringify({ message: 'Position ID is required.' }),
        };
    }

    const key = {
        PK: `ORG#POSITION#${positionId}`,
        SK: 'METADATA',
    };

    const command = new GetItemCommand({
        TableName: tableName,
        Key: marshall(key),
    });

    try {
        const { Item } = await dbClient.send(command);

        if (!Item) {
            console.warn(`Position not found for ID: ${positionId}.`);
            return {
                statusCode: 404,
                headers: headers,
                body: JSON.stringify({ message: 'Position not found.' }),
            };
        }

        const positionData = unmarshall(Item);

        // --- Decrypt and Structure the Final Response with Defaults ---
        // This ensures the response shape is consistent regardless of how the position was created.
        const decryptedData = {
            // Fields common to both simple and stepper forms
            positionId: positionData.positionId,
            positionTitle: positionData.positionTitle,
            positionCode: positionData.positionCode,
            reportsTo: positionData.reportsTo,
            salaryGrade: positionData.salaryGrade,
            
            // --- Fields that may ONLY exist on "Stepper Form" positions ---
            // Provide default empty values if they don't exist.
            departmentId: positionData.departmentId || null,
            positionLevel: positionData.positionLevel || "",
            employmentType: positionData.employmentType || "",
            positionDescription: positionData.positionDescription ? decrypt(positionData.positionDescription) : "",
            education: positionData.education || "",
            skills: positionData.skills || [], // Default to an empty array for lists
            certifications: positionData.certifications || [], // Default to an empty array for lists
            competencyLevel: positionData.competencyLevel || "",
            comments: positionData.comments ? decrypt(positionData.comments) : "",
            
            // Audit fields
            createdBy: positionData.createdBy,
            createdAt: positionData.createdAt,
        };

        console.log(`Successfully retrieved and decrypted position ID: ${positionId}`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ position: decryptedData }),
        };

    } catch (error) {
        console.error('Error getting position:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({ message: 'Failed to retrieve position.', error: error.message }),
        };
    }
};