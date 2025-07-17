// lib/hr-cdk-stack-stack.js

// Load environment variables
require('dotenv').config();

const { Stack, RemovalPolicy, CfnOutput } = require('aws-cdk-lib'); // Added CfnOutput
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const cognito = require('aws-cdk-lib/aws-cognito'); // Added Cognito library
const sqs = require('aws-cdk-lib/aws-sqs');
const sfn = require('aws-cdk-lib/aws-stepfunctions');
const tasks = require('aws-cdk-lib/aws-stepfunctions-tasks');
const { NodejsFunction } = require('aws-cdk-lib/aws-lambda-nodejs');
const path = require('path');
const { SqsEventSource } = require('aws-cdk-lib/aws-lambda-event-sources');
const { Duration } = require('aws-cdk-lib');

class HrCdkStackStack extends Stack {
  /**
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Updated check to include all table names from the .env file
    if (!process.env.PERSONNEL_TABLE_NAME || !process.env.ORGANIZATIONAL_TABLE_NAME || !process.env.TIME_MANAGEMENT_TABLE_NAME 
        || !process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME || !process.env.PAYROLL_TABLE_NAME || !process.env.AES_SECRET_KEY) {
      throw new Error('Missing required environment variables. Check .env for all five table names and the AES_SECRET_KEY.');
    }
    
    // 1. Cognito User Pool and Client
    const userPool = new cognito.UserPool(this, 'HRUserPool', {
      userPoolName: 'HR-System-User-Pool',
      selfSignUpEnabled: false, // Self sign-up is disabled
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'HRUserPoolClient', {
        userPool,
        generateSecret: false,
        authFlows: {
            userPassword: true, // This enables the USER_PASSWORD_AUTH flow
        },
    });
    
    // 2. DynamoDB Table
    // Personnel Table
    const personnelTable = new dynamodb.Table(this, 'PersonnelTable', {
      tableName: process.env.PERSONNEL_TABLE_NAME,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Organizational Table
    const organizationalTable = new dynamodb.Table(this, 'OrganizationalTable', {
        tableName: process.env.ORGANIZATIONAL_TABLE_NAME,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        removalPolicy: RemovalPolicy.DESTROY,
    });
    organizationalTable.addGlobalSecondaryIndex({
    indexName: 'departmentId-index', // The name used in the Lambda
    partitionKey: { name: 'departmentId', type: dynamodb.AttributeType.STRING },
});

    // Time Management Table
    const timeManagementTable = new dynamodb.Table(this, 'TimeManagementTable', {
        tableName: process.env.TIME_MANAGEMENT_TABLE_NAME,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        removalPolicy: RemovalPolicy.DESTROY,
    });
    // GSI1 is for employee-based queries
    timeManagementTable.addGlobalSecondaryIndex({
        indexName: 'GSI1',
        partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    // --- ADD THIS NEW GSI (GSI2) FOR CALENDAR QUERIES ---
    timeManagementTable.addGlobalSecondaryIndex({
        indexName: 'GSI2-DateIndex',
        partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING }, // e.g., 'EVENT#2025-07-11'
        sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },      // e.g., '10:00:00Z'
    });
    // --- ADD THIS NEW GSI (GSI3) FOR MEETING ROOM QUERIES ---
    timeManagementTable.addGlobalSecondaryIndex({
        indexName: 'GSI3-MeetingRoomIndex',
        partitionKey: { name: 'meetingRoom', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'startDateTime', type: dynamodb.AttributeType.STRING },
    });
    // We need a GSI on the TimeManagementTable to check for duplicate attendance records.
    timeManagementTable.addGlobalSecondaryIndex({
        indexName: 'GSI4-AttendanceDateIndex',
        partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING }, // e.g., 'ATT#<employeeId>'
        sortKey: { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },      // e.g., 'DATE#<YYYY-MM-DD>'
    });

    // Employee Timestamp Log Table
    const employeeTimestampLogTable = new dynamodb.Table(this, 'EmployeeTimestampLogTable', {
        tableName: process.env.EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        removalPolicy: RemovalPolicy.DESTROY,
    });
    employeeTimestampLogTable.addGlobalSecondaryIndex({
        indexName: 'GSI1',
        partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    employeeTimestampLogTable.addGlobalSecondaryIndex({
        indexName: 'GSI2',
        partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // --- Payroll Table ---
    const payrollTable = new dynamodb.Table(this, 'PayrollTable', {
        tableName: process.env.PAYROLL_TABLE_NAME,
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
        removalPolicy: RemovalPolicy.DESTROY,
    });
    payrollTable.addGlobalSecondaryIndex({
        indexName: 'GSI1', partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    payrollTable.addGlobalSecondaryIndex({
        indexName: 'GSI2', partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // --- SQS Queue ---
    const payslipCalculationQueue = new sqs.Queue(this, 'PayslipCalculationQueue', {
        visibilityTimeout: Duration.seconds(300), // Should be longer than the payslip calculator lambda's timeout
    });

    // 3. Environment variables for Lambda functions
    const lambdaEnvironment = {
      PERSONNEL_TABLE_NAME: personnelTable.tableName,
      ORGANIZATIONAL_TABLE_NAME: organizationalTable.tableName,
      TIME_MANAGEMENT_TABLE_NAME: timeManagementTable.tableName,
      EMPLOYEE_TIMESTAMP_LOG_TABLE_NAME: employeeTimestampLogTable.tableName,
      PAYROLL_TABLE_NAME: payrollTable.tableName,
      SQS_QUEUE_URL: payslipCalculationQueue.queueUrl,
      AES_SECRET_KEY: process.env.AES_SECRET_KEY,
    };
    
    // 4. API Gateway REST API and Cognito Authorizer
    const api = new apigateway.RestApi(this, 'HRComprehensiveRESTAPI', {
      restApiName: 'HR Comprehensive System REST API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Create the Cognito Authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'HRCognitoAuthorizer', {
        cognitoUserPools: [userPool],
        identitySource: 'method.request.header.Authorization',
    });

    // 5. Define business logic Lambda functions
    const functionProps = (entryPath) => ({
        entry: path.join(__dirname, entryPath),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        environment: lambdaEnvironment,
    });

    // Lambda function definitions
    // Personnel Lambdas
    const createEmployeeLambda = new NodejsFunction(this, 'CreateEmployeeLambda', functionProps('../lambda/personnel/dev-employee/createEmployee.js'));
    const getEmployeeDetailsLambda = new NodejsFunction(this, 'GetEmployeeDetailsLambda', functionProps('../lambda/personnel/dev-employee/getEmployee.js'));
    const updateEmployeeLambda = new NodejsFunction(this, 'UpdateEmployeeLambda', functionProps('../lambda/personnel/dev-employee/updateEmployee.js'));
    const deleteEmployeeLambda = new NodejsFunction(this, 'DeleteEmployeeLambda', functionProps('../lambda/personnel/dev-employee/deleteEmployee.js'));
    const getPersonalDataLambda = new NodejsFunction(this, 'GetPersonalDataLambda', functionProps('../lambda/personnel/dev-personalData/getPersonalData.js'));
    const updatePersonalDataLambda = new NodejsFunction(this, 'UpdatePersonalDataLambda', functionProps('../lambda/personnel/dev-personalData/updatePersonalData.js'));
    const getContactInfoLambda = new NodejsFunction(this, 'GetContactInfoLambda', functionProps('../lambda/personnel/dev-contactInfo/getContactInfo.js'));
    const updateContactInfoLambda = new NodejsFunction(this, 'UpdateContactInfoLambda', functionProps('../lambda/personnel/dev-contactInfo/updateContactInfo.js'));
    const getContractDetailsLambda = new NodejsFunction(this, 'GetContractDetailsLambda', functionProps('../lambda/personnel/dev-contractDetails/getContractDetails.js'));
    const updateContractDetailsLambda = new NodejsFunction(this, 'UpdateContractDetailsLambda', functionProps('../lambda/personnel/dev-contractDetails/updateContractDetails.js'));
    const listEmployeesLambda = new NodejsFunction(this, 'ListEmployeesLambda', functionProps('../lambda/personnel/listEmployees.js'));
    const searchEmployeesLambda = new NodejsFunction(this, 'SearchEmployeesLambda', functionProps('../lambda/personnel/searchEmployees.js'));

    // Organization Management Lambdas
    // POST Lambdas
    const createDepartmentLambda = new NodejsFunction(this, 'CreateDepartmentLambda', functionProps('../lambda/organization/dev-department/createDepartment.js'));
    const createPositionLambda = new NodejsFunction(this, 'CreatePositionLambda', functionProps('../lambda/organization/dev-position/createPosition.js'));
    const createPositionMethodLambda = new NodejsFunction(this, 'CreatePositionMethodLambda', functionProps('../lambda/organization/dev-position/createPositionMethod.js'));
    const createOrgUnitLambda = new NodejsFunction(this, 'CreateOrgUnitLambda', functionProps('../lambda/organization/dev-orgUnit/createOrgUnit.js'));
    const createJobClassificationLambda = new NodejsFunction(this, 'CreateJobClassificationLambda', functionProps('../lambda/organization/dev-jobClassification/createJobClassification.js'));
    // Singular GET Lambdas
    const getDepartmentLambda = new NodejsFunction(this, 'GetDepartmentLambda', functionProps('../lambda/organization/dev-department/getDepartment.js'));
    const getPositionLambda = new NodejsFunction(this, 'GetPositionLambda', functionProps('../lambda/organization/dev-position/getPosition.js'));
    const getOrgUnitLambda = new NodejsFunction(this, 'GetOrgUnitLambda', functionProps('../lambda/organization/dev-orgUnit/getOrgUnit.js'));
    const getJobClassificationLambda = new NodejsFunction(this, 'GetJobClassificationLambda', functionProps('../lambda/organization/dev-jobClassification/getJobClassification.js'));
    // List/Selection GET Lambdas
    const listDepartmentLambda = new NodejsFunction(this, 'ListDepartmentLambda', functionProps('../lambda/organization/dev-department/listDepartment.js'));
    const listPositionLambda = new NodejsFunction(this, 'ListPositionLambda', functionProps('../lambda/organization/dev-position/listPosition.js'));
    const listOrgUnitLambda = new NodejsFunction(this, 'ListOrgUnitLambda', functionProps('../lambda/organization/dev-orgUnit/listOrgUnit.js'));
    const listJobClassificationLambda = new NodejsFunction(this, 'ListJobClassificationLambda', functionProps('../lambda/organization/dev-jobClassification/listJobClassification.js'));
    // WBS-Code Creation
    const createWbsCodeLambda = new NodejsFunction(this, 'CreateWbsCodeLambda', functionProps('../lambda/organization/wbs-codes/createWbsCode.js'));

    // Time Management Lambdas
    // Config
    const configureLeaveFieldsLambda = new NodejsFunction(this, 'ConfigureLeaveFieldsLambda', functionProps('../lambda/time-management/config/dev-configureLeaveFields.js'));
    const getLeaveConfigLambda = new NodejsFunction(this, 'GetLeaveConfigLambda', functionProps('../lambda/time-management/config/dev-getLeaveConfig.js'));
    // Leave Requests
    const createLeaveRequestLambda = new NodejsFunction(this, 'CreateLeaveRequestLambda', functionProps('../lambda/time-management/leave-requests/dev-createLeaveRequest.js'));
    const fetchPendingLeaveRequestsLambda = new NodejsFunction(this, 'FetchPendingLeaveRequestsLambda', functionProps('../lambda/time-management/leave-requests/dev-fetchPendingLeaveRequests.js'));
    const getLeaveBalanceLambda = new NodejsFunction(this, 'GetLeaveBalanceLambda', functionProps('../lambda/time-management/leave-requests/dev-getLeaveBalance.js'));
    const updateLeaveRequestStatusLambda = new NodejsFunction(this, 'UpdateLeaveRequestStatusLambda', functionProps('../lambda/time-management/leave-requests/dev-updateLeaveRequestStatus.js'));
    // Attendance
    const createAttendanceRecordLambda = new NodejsFunction(this, 'CreateAttendanceRecordLambda', functionProps('../lambda/time-management/attendance/dev-createAttendanceRecord.js'));
    const getAttendanceRecordsLambda = new NodejsFunction(this, 'GetAttendanceRecordsLambda', functionProps('../lambda/time-management/attendance/dev-getAttendanceRecords.js'));
    // WBS Codes
    const getWbsCodesLambda = new NodejsFunction(this, 'GetWbsCodesLambda', functionProps('../lambda/time-management/wbs-codes/dev-getWbsCodes.js'));
    // Calendar
    const getCalendarEventsLambda = new NodejsFunction(this, 'GetCalendarEventsLambda', functionProps('../lambda/time-management/calendar/dev-getCalendarEvents.js'));
    const createCalendarEventLambda = new NodejsFunction(this, 'CreateCalendarEventLambda', functionProps('../lambda/time-management/calendar/dev-createCalendarEvent.js'));
    // Reports
    const generateTimesheetLambda = new NodejsFunction(this, 'GenerateTimesheetLambda', functionProps('../lambda/time-management/reports/dev-generateTimesheet.js'));
    // Timestamp Logging
    const createTimestampLambda = new NodejsFunction(this, 'CreateTimestampLambda', functionProps('../lambda/time-management/timestamp-logging/dev-createTimestamp.js'));
    const getTimestampHistoryLambda = new NodejsFunction(this, 'GetTimestampHistoryLambda', functionProps('../lambda/time-management/timestamp-logging/dev-getTimestampHistory.js'));
    const validateTimestampsLambda = new NodejsFunction(this, 'ValidateTimestampsLambda', functionProps('../lambda/time-management/timestamp-logging/dev-validateTimestamps.js'));
    const getTimestampSequenceLambda = new NodejsFunction(this, 'GetTimestampSequenceLambda', functionProps('../lambda/time-management/timestamp-logging/dev-getTimestampSequence.js'));
    // WBS Tracking
    const changeWbsCodeLambda = new NodejsFunction(this, 'ChangeWbsCodeLambda', functionProps('../lambda/time-management/wbs-tracking/dev-changeWbsCode.js'));

    // Payroll Management Lambdas
    // Payroll Setup
    const updateBankInfoLambda = new NodejsFunction(this, 'UpdateBankInfoLambda', functionProps('../lambda/personnel/dev-payroll-setup/updateBankInfo.js'));
    const updateCompensationLambda = new NodejsFunction(this, 'UpdateCompensationLambda', functionProps('../lambda/personnel/dev-payroll-setup/updateCompensation.js'));
    const updateTaxInfoLambda = new NodejsFunction(this, 'UpdateTaxInfoLambda', functionProps('../lambda/personnel/dev-payroll-setup/updateTaxInfo.js'));
    // Workflow Steps
    const startPayrollRunLambda = new NodejsFunction(this, 'StartPayrollRunLambda', functionProps('../lambda/payroll/dev-workflow-steps/startPayrollRun.js'));
    const getEmployeeListLambda = new NodejsFunction(this, 'GetEmployeeListLambda', functionProps('../lambda/payroll/dev-workflow-steps/getEmployeeList.js'));
    const finalizePayrollRunLambda = new NodejsFunction(this, 'FinalizePayrollRunLambda', functionProps('../lambda/payroll/dev-workflow-steps/finalizePayrollRun.js'));
    // SQS Worker
    const calculatePayslipLambda = new NodejsFunction(this, 'CalculatePayslipLambda', { ...functionProps('../lambda/payroll/dev-sqs-workers/calculatePayslip.js'), timeout: Duration.seconds(120) });
    // Payslip Management
    const getPayslipLambda = new NodejsFunction(this, 'GetPayslipLambda', functionProps('../lambda/payroll/dev-payslip/getPayslip.js'));
    const listPayslipsLambda = new NodejsFunction(this, 'ListPayslipsLambda', functionProps('../lambda/payroll/dev-payslip/listPayslips.js'));
    const updatePayslipStatusLambda = new NodejsFunction(this, 'UpdatePayslipStatusLambda', functionProps('../lambda/payroll/dev-payslip/updatePayslipStatus.js'));

    // --- SQS Event Source Mapping ---
    calculatePayslipLambda.addEventSource(new SqsEventSource(payslipCalculationQueue, {
        batchSize: 5, // Process up to 5 messages at a time
    }));

    // 6. Grant IAM Permissions (Centralized Permission Setup)
    // Personnel Table: Grant ReadWrite to all Lambdas that use it
    const personnelLambdas = [
        createEmployeeLambda, updateEmployeeLambda, deleteEmployeeLambda,
        getEmployeeDetailsLambda, getPersonalDataLambda, updatePersonalDataLambda,
        getContactInfoLambda, updateContactInfoLambda, getContractDetailsLambda,
        updateContractDetailsLambda, listEmployeesLambda, searchEmployeesLambda,
        createDepartmentLambda, createTimestampLambda, getTimestampHistoryLambda,
        getTimestampSequenceLambda, generateTimesheetLambda, changeWbsCodeLambda,
        validateTimestampsLambda, getWbsCodesLambda, fetchPendingLeaveRequestsLambda,
        getLeaveBalanceLambda, createCalendarEventLambda, getCalendarEventsLambda,
        createAttendanceRecordLambda, getAttendanceRecordsLambda,
        updateBankInfoLambda, updateCompensationLambda, updateTaxInfoLambda,
        getEmployeeListLambda, calculatePayslipLambda, updatePayslipStatusLambda
    ];
    personnelLambdas.forEach(fn => personnelTable.grantReadWriteData(fn));

    // Organizational Table: Grant ReadWrite to all relevant Lambdas
    const organizationalLambdas = [
        createDepartmentLambda, createPositionLambda, createOrgUnitLambda,
        createJobClassificationLambda, createPositionMethodLambda, createWbsCodeLambda,
        getDepartmentLambda, getPositionLambda, getOrgUnitLambda, getJobClassificationLambda,
        listDepartmentLambda, listPositionLambda, listOrgUnitLambda, listJobClassificationLambda,
        getWbsCodesLambda, createTimestampLambda, changeWbsCodeLambda,
        createCalendarEventLambda, getCalendarEventsLambda,
        createAttendanceRecordLambda, getAttendanceRecordsLambda,
        calculatePayslipLambda
    ];
    organizationalLambdas.forEach(fn => organizationalTable.grantReadWriteData(fn));

    // Time Management Permissions
    const timeManagementLambdas = [
        configureLeaveFieldsLambda, getLeaveConfigLambda, createLeaveRequestLambda,
        fetchPendingLeaveRequestsLambda, getLeaveBalanceLambda, createAttendanceRecordLambda,
        getWbsCodesLambda, getCalendarEventsLambda, createCalendarEventLambda, generateTimesheetLambda,
        getAttendanceRecordsLambda, updateLeaveRequestStatusLambda, calculatePayslipLambda
    ];
    timeManagementLambdas.forEach(fn => timeManagementTable.grantReadWriteData(fn));

    const timestampLambdas = [
        createTimestampLambda, getTimestampHistoryLambda, validateTimestampsLambda,
        getTimestampSequenceLambda, changeWbsCodeLambda, generateTimesheetLambda,
        createAttendanceRecordLambda
    ];
    timestampLambdas.forEach(fn => employeeTimestampLogTable.grantReadWriteData(fn));

    // Payroll Table: Centralize
    const payrollLambdas = [
        startPayrollRunLambda, finalizePayrollRunLambda, calculatePayslipLambda,
        getPayslipLambda, listPayslipsLambda, updatePayslipStatusLambda
    ];
    payrollLambdas.forEach(fn => payrollTable.grantReadWriteData(fn));

    // SQS Permissions
    payslipCalculationQueue.grantSendMessages(startPayrollRunLambda);
    payslipCalculationQueue.grantConsumeMessages(calculatePayslipLambda);

    // --- Step Functions State Machine Definition ---
    const getEmployeeListTask = new tasks.LambdaInvoke(this, 'GetEmployeeListTask', { lambdaFunction: getEmployeeListLambda, outputPath: '$.Payload' });
    const calculatePayslipTask = new tasks.SqsSendMessage(this, 'CalculatePayslipTask', { queue: payslipCalculationQueue, messageBody: sfn.TaskInput.fromJsonPathAt('$.employeeId') });
    const finalizeRunTask = new tasks.LambdaInvoke(this, 'FinalizeRunTask', { lambdaFunction: finalizePayrollRunLambda });
    const failRunTask = new sfn.Fail(this, 'FailRunTask', {
        cause: 'Payroll run failed',
        error: 'See execution logs for details',
    });

    const processEmployeesMap = new sfn.Map(this, 'ProcessEmployeesInParallel', {
        maxConcurrency: 10,
        itemsPath: '$.employees',
        itemSelector: {
            employeeId: sfn.JsonPath.stringAt('$$.Map.Item.Value'),
        },
    });
    processEmployeesMap.itemProcessor(calculatePayslipTask);

    finalizeRunTask.addCatch(failRunTask); // Attach the catch handler to the task directly

    const definition = getEmployeeListTask
    .next(processEmployeesMap)
    .next(finalizeRunTask); // Don't call .addCatch here

    const payrollStateMachine = new sfn.StateMachine(this, 'PayrollWorkflow', {
        definitionBody: sfn.DefinitionBody.fromChainable(definition),
        timeout: Duration.minutes(30),
    });

    // Add state machine ARN to startPayrollRun Lambda environment
    startPayrollRunLambda.addEnvironment('STATE_MACHINE_ARN', payrollStateMachine.stateMachineArn);
    payrollStateMachine.grantStartExecution(startPayrollRunLambda);
    
    // 7. Define API Gateway Resources and Methods with Authorization
    const employees = api.root.addResource('personnel').addResource('employees');
    const employeeId = employees.addResource('{employeeId}');

    // Helper function to add methods with the Cognito authorizer attached
    const addAuthorizedMethod = (resource, method, integration) => {
        resource.addMethod(method, integration, {
            authorizationType: apigateway.AuthorizationType.COGNITO,
            authorizer: authorizer,
        });
    };
    
    // Personnel Endpoints (Protected)
    // dev-employee and listEmployees
    addAuthorizedMethod(employees, 'POST', new apigateway.LambdaIntegration(createEmployeeLambda));
    addAuthorizedMethod(employees, 'GET', new apigateway.LambdaIntegration(listEmployeesLambda));
    addAuthorizedMethod(employeeId, 'GET', new apigateway.LambdaIntegration(getEmployeeDetailsLambda));
    addAuthorizedMethod(employeeId, 'PUT', new apigateway.LambdaIntegration(updateEmployeeLambda));
    addAuthorizedMethod(employeeId, 'DELETE', new apigateway.LambdaIntegration(deleteEmployeeLambda));

    // dev-personalData
    const personalData = employeeId.addResource('personal-data');
    addAuthorizedMethod(personalData, 'GET', new apigateway.LambdaIntegration(getPersonalDataLambda));
    addAuthorizedMethod(personalData, 'PUT', new apigateway.LambdaIntegration(updatePersonalDataLambda));

    // dev-contactInfo
    const contactInfo = employeeId.addResource('contact-info');
    addAuthorizedMethod(contactInfo, 'GET', new apigateway.LambdaIntegration(getContactInfoLambda));
    addAuthorizedMethod(contactInfo, 'PUT', new apigateway.LambdaIntegration(updateContactInfoLambda));

    // dev-contractDetails
    const contractDetails = employeeId.addResource('contract-details');
    addAuthorizedMethod(contractDetails, 'GET', new apigateway.LambdaIntegration(getContractDetailsLambda));
    addAuthorizedMethod(contractDetails, 'PUT', new apigateway.LambdaIntegration(updateContractDetailsLambda));

    // Search Employees
    employees.addResource('search').addMethod('GET', new apigateway.LambdaIntegration(searchEmployeesLambda), {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: authorizer,
    });

    // Organization Endpoints (Unprotected)
    const organization = api.root.addResource('organization');
    const orgParentById = organization.addResource('{id}');

    // Department
    const department = organization.addResource('department');
    addAuthorizedMethod(department, 'POST', new apigateway.LambdaIntegration(createDepartmentLambda));
    addAuthorizedMethod(department, 'GET', new apigateway.LambdaIntegration(listDepartmentLambda));
    const departmentById = department.addResource('{departmentId}');
    addAuthorizedMethod(departmentById, 'GET', new apigateway.LambdaIntegration(getDepartmentLambda));

    // Position
    const position = organization.addResource('position');
    addAuthorizedMethod(position, 'POST', new apigateway.LambdaIntegration(createPositionLambda));
    addAuthorizedMethod(position, 'GET', new apigateway.LambdaIntegration(listPositionLambda));
    const positionById = position.addResource('{positionId}');
    addAuthorizedMethod(positionById, 'GET', new apigateway.LambdaIntegration(getPositionLambda));
    addAuthorizedMethod(orgParentById.addResource('position-method'), 'POST', new apigateway.LambdaIntegration(createPositionMethodLambda));

    // Org Unit
    const orgUnitCollection = organization.addResource('org-unit');
    addAuthorizedMethod(orgUnitCollection, 'GET', new apigateway.LambdaIntegration(listOrgUnitLambda));
    const orgUnitById = orgUnitCollection.addResource('{unitId}');
    addAuthorizedMethod(orgUnitById, 'GET', new apigateway.LambdaIntegration(getOrgUnitLambda));
    addAuthorizedMethod(orgParentById.addResource('org-unit'), 'POST', new apigateway.LambdaIntegration(createOrgUnitLambda));

    // Job Classification
    const jobClassification = organization.addResource('job-classification');
    addAuthorizedMethod(jobClassification, 'POST', new apigateway.LambdaIntegration(createJobClassificationLambda));
    addAuthorizedMethod(jobClassification, 'GET', new apigateway.LambdaIntegration(listJobClassificationLambda));
    const jobClassificationById = jobClassification.addResource('{jobClassificationId}');
    addAuthorizedMethod(jobClassificationById, 'GET', new apigateway.LambdaIntegration(getJobClassificationLambda));

    // WBS Codes
    const wbsCodes = organization.addResource('wbs-codes');
    addAuthorizedMethod(wbsCodes, 'POST', new apigateway.LambdaIntegration(createWbsCodeLambda));

    // Time Management Endpoints (Protected)
    const time = api.root.addResource('time');

    // Config
    const config = time.addResource('config');
    const leaveFields = config.addResource('leave-fields');
    addAuthorizedMethod(leaveFields, 'POST', new apigateway.LambdaIntegration(configureLeaveFieldsLambda));
    addAuthorizedMethod(leaveFields, 'GET', new apigateway.LambdaIntegration(getLeaveConfigLambda));

    // Requests
    const requests = time.addResource('requests');
    const leaveRequest = requests.addResource('leave');
    addAuthorizedMethod(leaveRequest, 'POST', new apigateway.LambdaIntegration(createLeaveRequestLambda));
    addAuthorizedMethod(leaveRequest, 'PUT', new apigateway.LambdaIntegration(updateLeaveRequestStatusLambda));
    const pendingRequests = requests.addResource('pending').addResource('{employeeId}');
    addAuthorizedMethod(pendingRequests, 'GET', new apigateway.LambdaIntegration(fetchPendingLeaveRequestsLambda));
    
    // Attendance
    const attendance = time.addResource('attendance');
    addAuthorizedMethod(attendance, 'POST', new apigateway.LambdaIntegration(createAttendanceRecordLambda));
    const attendanceById = attendance.addResource('{employeeId}');
    addAuthorizedMethod(attendanceById, 'GET', new apigateway.LambdaIntegration(getAttendanceRecordsLambda));
    
    // WBS
    const wbs = time.addResource('wbs');
    addAuthorizedMethod(wbs.addResource('codes'), 'GET', new apigateway.LambdaIntegration(getWbsCodesLambda));
    addAuthorizedMethod(wbs.addResource('change'), 'POST', new apigateway.LambdaIntegration(changeWbsCodeLambda));

    // Calendar
    const calendar = time.addResource('calendar');
    const events = calendar.addResource('events');
    addAuthorizedMethod(events, 'GET', new apigateway.LambdaIntegration(getCalendarEventsLambda));
    addAuthorizedMethod(events, 'POST', new apigateway.LambdaIntegration(createCalendarEventLambda));

    // Balance
    const balance = time.addResource('balance').addResource('leave').addResource('{employeeId}');
    addAuthorizedMethod(balance, 'GET', new apigateway.LambdaIntegration(getLeaveBalanceLambda));

    // Reports
    const reports = time.addResource('reports');
    const timesheet = reports.addResource('timesheet').addResource('{employeeId}');
    addAuthorizedMethod(timesheet, 'GET', new apigateway.LambdaIntegration(generateTimesheetLambda));

    // Timestamp
    const timestamp = time.addResource('timestamp');
    addAuthorizedMethod(timestamp.addResource('log'), 'POST', new apigateway.LambdaIntegration(createTimestampLambda));
    addAuthorizedMethod(timestamp.addResource('history').addResource('{employeeId}'), 'GET', new apigateway.LambdaIntegration(getTimestampHistoryLambda));
    addAuthorizedMethod(timestamp.addResource('validate').addResource('{employeeId}'), 'GET', new apigateway.LambdaIntegration(validateTimestampsLambda));
    addAuthorizedMethod(timestamp.addResource('sequence').addResource('{employeeId}'), 'GET', new apigateway.LambdaIntegration(getTimestampSequenceLambda));

    // Payroll Endpoints (Protected)
    // dev-payroll-setup
    const employeeIdSetup = employeeId;
    addAuthorizedMethod(employeeIdSetup.addResource('bank-info'), 'PUT', new apigateway.LambdaIntegration(updateBankInfoLambda));
    addAuthorizedMethod(employeeIdSetup.addResource('compensation'), 'PUT', new apigateway.LambdaIntegration(updateCompensationLambda));
    addAuthorizedMethod(employeeIdSetup.addResource('tax-info'), 'PUT', new apigateway.LambdaIntegration(updateTaxInfoLambda));
    
    // Payroll
    const payroll = api.root.addResource('payroll');
    addAuthorizedMethod(payroll.addResource('run'), 'POST', new apigateway.LambdaIntegration(startPayrollRunLambda));

    // Payslips
    const payslips = payroll.addResource('payslips');
    addAuthorizedMethod(payslips, 'GET', new apigateway.LambdaIntegration(listPayslipsLambda));
    addAuthorizedMethod(payslips.addResource('status'), 'PUT', new apigateway.LambdaIntegration(updatePayslipStatusLambda));
    addAuthorizedMethod(payslips.addResource('{id}'), 'GET', new apigateway.LambdaIntegration(getPayslipLambda));

    // CloudFormation Outputs
    new CfnOutput(this, 'UserPoolId', {
        value: userPool.userPoolId,
        description: 'The ID of the Cognito User Pool',
    });

    new CfnOutput(this, 'UserPoolClientId', {
        value: userPoolClient.userPoolClientId,
        description: 'The ID of the Cognito User Pool Client',
    });
  }
}

module.exports = { HrCdkStackStack };