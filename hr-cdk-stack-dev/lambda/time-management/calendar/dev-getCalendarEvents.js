// lambda/time-management/calendar/dev-getCalendarEvents.js

const { DynamoDBClient, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { decrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getUserRole, getRequestingUser } = require('../../utils/authUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const timeTable = process.env.TIME_MANAGEMENT_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
    console.log('Request to get calendar events received with event:', event);

    try {
        // 1. --- Authorization & Role Identification ---
        if (!isAuthorized(event, ['hr_admin', 'manager_admin', 'employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }
        const userRole = getUserRole(event);
        const employeeId = getRequestingUser(event);
        
        const query = event.queryStringParameters || {};
        const limit = query.limit ? parseInt(query.limit, 10) : 20;
        const nextToken = query.nextToken;

        // 2. --- Scan for ALL calendar event items ---
        // A Scan is necessary here because the filtering logic is complex and role-dependent.
        const scanCommand = new ScanCommand({
            TableName: timeTable,
            FilterExpression: 'begins_with(PK, :pk_prefix)',
            ExpressionAttributeValues: { ':pk_prefix': { S: 'TIME#EVENT#' } }
        });

        const { Items = [] } = await dbClient.send(scanCommand);
        const allEvents = Items.map(unmarshall);

        // 3. --- Role-Based Filtering ---
        let filtered = [];

        if (userRole === 'employee') {
            console.log(`Filtering events for employee '${employeeId}'`);
            
            // a. Get the employee's department ID
            const { Item: contractItem } = await dbClient.send(new GetItemCommand({
                TableName: personnelTable,
                Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#CONTRACT_DETAILS' })
            }));
            const employeeDepartmentId = unmarshall(contractItem)?.department;

            // b. Get all WBS codes for that department
            const wbsScanCommand = new ScanCommand({
                TableName: orgTable,
                FilterExpression: 'begins_with(PK, :pk_prefix) AND departmentId = :deptId',
                ExpressionAttributeValues: {
                    ':pk_prefix': { S: 'ORG#WBS#' },
                    ':deptId': { S: employeeDepartmentId }
                }
            });
            const { Items: wbsItems = [] } = await dbClient.send(wbsScanCommand);
            const departmentWbsCodes = wbsItems.map(item => unmarshall(item).wbsCode);
            
            // c. Filter the events
            filtered = allEvents.filter(eventObj => {
                // Rule 1: Always include events where the employee is an attendee.
                if (eventObj.attendees && eventObj.attendees.includes(employeeId)) {
                    return true;
                }
                // Rule 2: Include events that have a WBS code linked to the employee's department.
                if (eventObj.wbsCode && departmentWbsCodes.includes(eventObj.wbsCode)) {
                    return true;
                }
                return false;
            });

        } else { // For hr_admin and manager_admin
            console.log('Admin role detected. Applying query parameter filters.');
            
            const filterableFields = ['eventType', 'meetingRoom', 'createdBy', 'createdAt'];
            filtered = allEvents.filter(eventObj => {
                if (query.startDateTime && new Date(eventObj.startDateTime) < new Date(query.startDateTime)) return false;
                if (query.endDateTime && new Date(eventObj.endDateTime) > new Date(query.endDateTime)) return false;
                if (query.eventTitle && !eventObj.eventTitle.toLowerCase().includes(query.eventTitle.toLowerCase())) return false;
                
                for (const key of filterableFields) {
                    if (query[key] && eventObj[key]?.toString().toLowerCase() !== query[key].toLowerCase()) {
                        return false;
                    }
                }
                return true;
            });
        }

        // 4. --- Paginate the filtered results ---
        const startIndex = nextToken ? parseInt(Buffer.from(nextToken, 'base64').toString('utf8')) : 0;
        const endIndex = startIndex + limit;
        const paginatedItems = filtered.slice(startIndex, endIndex);
        const newNextToken = endIndex < filtered.length ? Buffer.from(endIndex.toString()).toString('base64') : null;

        // 5. --- Format and decrypt the final page of results ---
        const results = paginatedItems.map(eventObj => {
            if (eventObj.eventDescription) {
                eventObj.eventDescription = decrypt(eventObj.eventDescription);
            }
            delete eventObj.PK;
            delete eventObj.SK;
            delete eventObj.GSI1PK; delete eventObj.GSI1SK; delete eventObj.GSI2PK; delete eventObj.GSI2SK;
            return eventObj;
        });

        console.log(`Returning ${results.length} of ${filtered.length} filtered calendar events.`);
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                events: results,
                count: results.length,
                nextToken: newNextToken,
            }),
        };
    } catch (error) {
        console.error('Error fetching calendar events:', error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                message: 'Internal Server Error. Failed to retrieve calendar events.',
                error: error.message,
            }),
        };
    }
};