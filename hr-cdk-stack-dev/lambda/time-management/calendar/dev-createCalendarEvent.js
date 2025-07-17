// lambda/time-management/calendar/dev-createCalendarEvent.js

const { DynamoDBClient, PutItemCommand, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { encrypt } = require('../../utils/cryptoUtil');
const { isAuthorized, getRequestingUser, getUserRole } = require('../../utils/authUtil');
const { validateBody } = require('../../utils/validationUtil');

const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const timeTable = process.env.TIME_MANAGEMENT_TABLE_NAME;
const personnelTable = process.env.PERSONNEL_TABLE_NAME;
const orgTable = process.env.ORGANIZATIONAL_TABLE_NAME;
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// --- Validation Helper Functions ---

function normalizeDate(input) {
    if (!input) return null;

    // MM/DD/YYYY → YYYY-MM-DD
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
        return new Date(input.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2'));
    }

    // YYYY/MM/DD → YYYY-MM-DD
    if (/^\d{4}\/\d{2}\/\d{2}$/.test(input)) {
        return new Date(input.replace(/\//g, '-'));
    }

    return new Date(input); // ISO-safe
}

async function validateAttendees(attendeeIds) {
    if (!Array.isArray(attendeeIds)) throw new Error('Attendees must be an array.');
    if (attendeeIds.length > 50) throw new Error('Attendee list cannot exceed 50 participants.');
    
    console.log(`Validating ${attendeeIds.length} attendees...`);
    await Promise.all(attendeeIds.map(async (id) => {
        
        // Fetch the entire PERSONAL_DATA item to validate existence and status.
        const { Item } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${id}`, SK: 'SECTION#PERSONAL_DATA' }),
        }));

        // Check 1: Does the employee exist at all?
        if (!Item) {
            throw new Error(`Invalid attendee: Employee with ID '${id}' not found.`);
        }
        
        const employeeData = unmarshall(Item);

        // Check 2: Is the employee active?
        if (employeeData.status !== 'ACTIVE') {
            throw new Error(`Invalid attendee: Employee with ID '${id}' is not active.`);
        }
    }));
    console.log('All attendees validated successfully.');
}

async function validateWbsCode(wbsCode, userRole, employeeId) {
    if (!wbsCode) return; // WBS is optional
    
    // First, validate the WBS code exists and is active
    const { Item: wbsItem } = await dbClient.send(new GetItemCommand({
        TableName: orgTable,
        Key: marshall({ PK: `ORG#WBS#${wbsCode}`, SK: 'METADATA' })
    }));
    if (!wbsItem || !unmarshall(wbsItem).isActive) {
        throw new Error(`The provided WBS code '${wbsCode}' is not valid or active.`);
    }
    const wbsData = unmarshall(wbsItem);
    console.log(`WBS Code '${wbsCode}' exists and is active.`);

    // --- NEW: If user is an employee, cross-reference department ---
    if (userRole === 'employee') {
        const { Item: contractItem } = await dbClient.send(new GetItemCommand({
            TableName: personnelTable,
            Key: marshall({ PK: `EMPLOYEE#${employeeId}`, SK: 'SECTION#CONTRACT_DETAILS' })
        }));
        if (!contractItem) throw new Error('Could not find your contract details to validate WBS code.');
        
        const employeeDepartmentId = unmarshall(contractItem).department;
        if (wbsData.departmentId !== employeeDepartmentId) {
            throw new Error(`Forbidden: You can only use WBS codes assigned to your department ('${employeeDepartmentId}').`);
        }
        console.log("WBS code department matches employee's department.");
    }
}

async function isRoomAvailable(meetingRoom, startDateTime, endDateTime, eventIdToExclude = null) {
    if (!meetingRoom) return;
    console.log(`Checking availability for room: ${meetingRoom}`);
    
    let filterExpression = 'endDateTime > :start';
    const expressionAttributeValues = {
        ':room': { S: meetingRoom },
        ':start': { S: startDateTime },
        ':end': { S: endDateTime },
    };

    // If we are updating an event, we must exclude it from the conflict check
    if (eventIdToExclude) {
        filterExpression += ' AND eventId <> :eventId';
        expressionAttributeValues[':eventId'] = { S: eventIdToExclude };
    }

    const command = new QueryCommand({
        TableName: timeTable,
        IndexName: 'GSI3-MeetingRoomIndex',
        KeyConditionExpression: 'meetingRoom = :room AND startDateTime < :end',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionAttributeValues
    });

    const { Items } = await dbClient.send(command);
    if (Items && Items.length > 0) {
        throw new Error(`Conflict: Meeting room '${meetingRoom}' is already booked during this time.`);
    }
    console.log(`Room '${meetingRoom}' is available.`);
}

async function checkForAttendeeConflicts(attendees, startDateTime, endDateTime, eventIdToExclude = null) {
    console.log(`Checking for event and leave conflicts for ${attendees.length} attendees...`);
    
    const eventStart = new Date(startDateTime);
    const eventEnd = new Date(endDateTime);

    await Promise.all(attendees.map(async (attendeeId) => {
        
        // Step A: Fetch ALL potentially conflicting records for this one attendee using the GSI.
        // We query only by the Partition Key to get all leaves and events for the user.
        const command = new QueryCommand({
            TableName: timeTable,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: {
                ':pk': { S: `EMP#${attendeeId}` },
            }
        });

        const { Items } = await dbClient.send(command);
        const existingRecords = Items ? Items.map(unmarshall) : [];
        
        // Step B: Find the first record that is a relevant conflict and overlaps.
        const overlappingRecord = existingRecords.find(rec => {
            // If we are updating an event, don't compare it against itself.
            if (eventIdToExclude && rec.eventId === eventIdToExclude) {
                return false;
            }

            // Only consider Approved leaves or other Calendar events as conflicts.
            const isRelevantConflict = (rec.formType === 'CALENDAR_EVENT') || (rec.formType === 'LEAVE_REQUEST' && rec.approvalStatus === 'Approved');
            if (!isRelevantConflict) {
                return false;
            }
            
            // Get the start and end dates for the existing record.
            const recStart = normalizeDate(rec.startDate) || new Date(rec.startDateTime);
            const recEnd = normalizeDate(rec.endDate) || new Date(rec.endDateTime);

            // Perform the date overlap check.
            return Math.max(eventStart.getTime(), recStart.getTime()) < Math.min(eventEnd.getTime(), recEnd.getTime());
        });

        if (overlappingRecord) {
            const conflictType = overlappingRecord.formType === 'LEAVE_REQUEST' ? 'an approved leave request' : 'another calendar event';
            throw new Error(`Conflict: Attendee '${attendeeId}' already has ${conflictType} during this time.`);
        }
    }));
    
    console.log('No conflicts found for any attendee.');
}

// --- Main Handler ---
exports.handler = async (event) => {
    console.log('Create calendar event request received.');
    try {
        // 1. --- Authorization & Basic Validation ---
        if (!isAuthorized(event, ['hr_admin', 'manager_admin', 'employee'])) {
            return { statusCode: 403, headers: headers, body: JSON.stringify({ message: 'Forbidden: You do not have permission to access this resource.' }) };
        }

        const body = JSON.parse(event.body);
        const requiredFields = ['eventType', 'eventTitle', 'startDateTime', 'endDateTime', 'attendees'];
        const validationResult = validateBody(body, requiredFields);
        if (!validationResult.isValid) {
            return { statusCode: 400, headers: headers, body: JSON.stringify({ message: validationResult.message }) };
        }
        
        const userRole = getUserRole(event);
        const creatorId = getRequestingUser(event);

        // 2. --- Run All Validations ---
        console.log("Step 2: Performing all business rule validations...");

        // a. Synchronous Validations first
        const startDate = new Date(body.startDateTime);
        const endDate = new Date(body.endDateTime);
        if (endDate <= startDate) throw new Error('End date must be after start date.');
        if ((endDate - startDate) > 24 * 60 * 60 * 1000) throw new Error('Event duration cannot exceed 24 hours.');

        if (body.recurring === true) {
            const validPatterns = ['DAILY', 'WEEKLY', 'MONTHLY'];
            if (!body.recurrencePattern || !validPatterns.includes(body.recurrencePattern.toUpperCase())) {
                throw new Error('A valid recurrencePattern (DAILY, WEEKLY, or MONTHLY) is required for recurring events.');
            }
        }

        // b. Asynchronous Validations (run concurrently for efficiency)
        await Promise.all([
            validateAttendees(body.attendees),
            validateWbsCode(body.wbsCode, userRole, creatorId),
            isRoomAvailable(body.meetingRoom, body.startDateTime, body.endDateTime),
            checkForAttendeeConflicts(body.attendees, body.startDateTime, body.endDateTime)
        ]);
        
        console.log("All validations passed.");

        // 3. --- Prepare and Construct Item ---
        const eventId = uuidv4();
        const now = new Date().toISOString();

        const eventItem = {
            PK: `TIME#EVENT#${eventId}`,
            SK: 'METADATA',
            GSI1PK: `EMP#${body.attendees.join('#EMP#')}`,
            GSI1SK: `EVENT#${body.startDateTime}`,
            GSI2PK: `EVENT#${startDate.toISOString().split('T')[0]}`,
            GSI2SK: body.startDateTime,
            eventId,
            formType: 'CALENDAR_EVENT',
            eventTitle: body.eventTitle,
            eventType: body.eventType.toUpperCase(),
            startDateTime: body.startDateTime,
            endDateTime: body.endDateTime,
            eventDescription: body.eventDescription ? encrypt(body.eventDescription) : undefined,
            attendees: body.attendees,
            meetingRoom: body.meetingRoom,
            wbsCode: body.wbsCode,
            allDay: body.allDay || false,
            recurring: body.recurring || false,
            recurrencePattern: body.recurring ? body.recurrencePattern.toUpperCase() : undefined,
            createdAt: now,
            createdBy: creatorId,
            updatedAt: now,
            updatedBy: creatorId,
        };

        const command = new PutItemCommand({
            TableName: timeTable,
            Item: marshall(eventItem, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(PK)'
        });

        // 4. --- Execute Database Command ---
        await dbClient.send(command);
        console.log(`Calendar event '${eventId}' created successfully.`);
        
        return { statusCode: 201, headers: headers, body: JSON.stringify({ message: 'Calendar event created successfully.', eventId }) };

    } catch (error) {
        console.error('Error creating calendar event:', error);
        return { statusCode: 400, headers: headers, body: JSON.stringify({ message: 'Failed to create event.', error: error.message }) };
    }
};