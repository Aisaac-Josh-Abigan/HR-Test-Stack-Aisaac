# HR Comprehensive System Backend

![AWS](https://img.shields.io/badge/AWS-232F3E?style=for-the-badge&logo=amazon-aws&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![DynamoDB](https://img.shields.io/badge/DynamoDB-4053D6?style=for-the-badge&logo=amazondynamodb&logoColor=white)
![Cognito](https://img.shields.io/badge/Cognito-FF4742?style=for-the-badge&logo=amazoncognito&logoColor=white)

##  Overview

The **HR Comprehensive System** is a secure, serverless HR management backend built with the **AWS CDK (JavaScript)**. It provides a robust set of APIs to efficiently manage employee records, including personal data, contact information, and contract details.

The architecture leverages a suite of managed AWS services like Lambda, API Gateway, DynamoDB, and Cognito to create a scalable, cost-effective, and low-maintenance solution.

### Key Features
*   **Secure by Design:** All endpoints are protected by a Cognito User Pool Authorizer, ensuring only authenticated users can access the API.
*   **Data Encryption:** All Personally Identifiable Information (PII) is encrypted at rest using AES-256, with keys managed securely.
*   **Atomic Operations:** Critical operations like creating or updating employee records are fully transactional, guaranteeing data consistency and preventing partial updates.
*   **Serverless & Scalable:** Built on Lambda and DynamoDB, the system automatically scales with demand and you only pay for what you use.
*   **Single-Table Design:** Utilizes a modern DynamoDB single-table design pattern for efficient data retrieval and complex access patterns.

---

## 📚 Table of Contents
- [Project Structure](#-project-structure)
- [Setup & Prerequisites](#️-setup--prerequisites)
- [Deployment Guide](#-deployment-guide)
- [Local Development & Testing Workflow](#-local-development--testing-workflow)
- [API Endpoint Documentation](#-api-endpoint-documentation)
- [Security Principles](#️-security-principles)
- [Git Workflow](#-git-workflow)
- [Troubleshooting](#️-troubleshooting)
- [Intern Onboarding Notes](#-intern-onboarding-notes)

---

## 📂 Project Structure
```text
hr-cdk-stack/
  ├── bin/                      # CDK application entrypoint
  ├── lambda/                   # Source code for all Lambda functions
  |   |── authorizers/          # (Unused) Custom authorizer example
  │   ├── personnel/            # Business logic for personnel APIs
  │   │   ├── dev-employee/       # Core employee CRUD (Create, Get, Update, Delete)
  │   │   ├── dev-personalData/   # Endpoints for the Personal Data section
  │   │   ├── dev-contactInfo/    # Endpoints for the Contact Info section
  │   │   ├── dev-contractDetails/  # Endpoints for the Contract Details section
  │   │   ├── listEmployees.js    # Logic to list and filter all employees
  │   │   └── searchEmployees.js  # Logic for partial-match search
  │   └── utils/                  # Shared utility functions
  │       ├── cryptoUtil.js       # Reusable encryption/decryption functions
  │       └── validationUtil.js   # Reusable input validation logic
  ├── lib/                      # CDK Stack definition (The core infrastructure-as-code)
  ├── test/                     # Jest unit tests for the stack
  ├── .env                      # Local environment variables (gitignored)
  ├── cdk.json 
  ├── package.json 
  └── README.md
```

---

## ⚙️ Setup & Prerequisites

1.  **Node.js:** Ensure you have Node.js (v20.x or later) and npm installed.
2.  **AWS CLI:** Install and configure the AWS CLI with credentials for your AWS account.
    ```sh
    aws configure
    ```
3.  **AWS CDK CLI:** Install the CDK toolkit globally.
    ```sh
    npm install -g aws-cdk
    ```
4.  **Clone & Install:** Clone the repository and install the project dependencies.
    ```sh
    git clone <repository-url>
    cd hr-cdk-stack
    npm install
    ```
5.  **Create Environment File:** Create a `.env` file for local configuration.

    > **IMPORTANT:** The `.env` file is gitignored and should **never** be committed to version control.

    ```sh
    # In your terminal
    cp .env.example .env
    ```
    Now, open the newly created `.env` file and fill in the values:
    ```env
    PERSONNEL_TABLE_NAME=YourDynamoDBTableName
    AES_SECRET_KEY=a-very-strong-32-character-key!!
    ```
    > **Note:** The `AES_SECRET_KEY` must be exactly 32 characters long for AES-256 encryption.

---

## 🚀 Deployment Guide

Follow these steps to deploy the infrastructure to your AWS account.

1.  **Bootstrap CDK (First-Time Only):** If you've never used CDK in this AWS account/region before, you need to bootstrap it.
    ```sh
    cdk bootstrap
    ```
2.  **Synthesize (Optional but Recommended):** Check your code for errors and see the CloudFormation template that will be generated.
    ```sh
    cdk synth
    ```
3.  **Deploy the Stack:** This command will build and deploy all the resources (DynamoDB table, Lambdas, API Gateway, Cognito Pool) to your AWS account.
    ```sh
    cdk deploy
    ```
    > After a successful deployment, the CDK will print **Outputs**, including the `UserPoolId` and `UserPoolClientId`. **Save these values**, as you will need them for testing.

---

## 💻 Local Development & Testing Workflow

All API endpoints are protected. To test them, you must get a valid authentication token from Cognito.

### Step 1: Create a Test User in AWS Cognito

Since self sign-up is disabled, you must create users manually.

1.  Go to the **AWS Cognito Console**.
2.  Find and click on your User Pool (`HR-System-User-Pool`).
3.  Go to the **Users** tab and click **Create user**.
4.  Enter an email for the username (e.g., `testuser@example.com`), mark the email as verified, and set a temporary password.

### Step 2: Set a Permanent Password for the User

Use the AWS CLI to confirm the user and set their permanent password. Replace the placeholders with your values.

```sh
aws cognito-idp admin-set-user-password \
  --user-pool-id <YOUR_USER_POOL_ID> \
  --username "testuser@example.com" \
  --password "YourStrongPassword!123" \
  --permanent
```

### Step 3: Authenticate and Get a Token

Now, log in as the user to get your session tokens.

```sh
aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id <YOUR_USER_POOL_CLIENT_ID> \
  --auth-parameters USERNAME="testuser@example.com",PASSWORD="YourStrongPassword!123"
```
The command will return a JSON object. Find and copy the entire **`IdToken`** string. This is the token you will use to authorize your API requests.

### Step 4: Use the Token in Postman

1.  In Postman, open your request.
2.  Go to the **Authorization** tab.
3.  Set the **Type** to **Bearer Token**.
4.  Paste the **`IdToken`** you copied into the **Token** field.
5.  Send your request. It will now be authorized.

> **Pro Tip:** In Postman, you can store the token in a collection variable (e.g., `{{authToken}}`) and set the collection's authorization to use it. This way, you only have to update the token in one place.

---

## 📋 API Endpoint Documentation

For detailed request/response examples for each endpoint, please refer to the documentation within the Postman collection itself.

### Base URL
`https://<api-id>.execute-api.<region>.amazonaws.com/prod`

### Endpoint Summary
| Method   | Path                                                | Description                      |
| :------- | :-------------------------------------------------- | :------------------------------- |
| `POST`   | `/personnel/employees`                              | Create a new, complete employee record. |
| `GET`    | `/personnel/employees`                              | List and filter all employees. |
| `GET`    | `/personnel/employees/search`                       | Perform a partial-match search. |
| `GET`    | `/personnel/employees/{employeeId}`                 | Get a single employee's full record. |
| `PUT`    | `/personnel/employees/{employeeId}`                 | Update a single employee's full record. |
| `DELETE` | `/personnel/employees/{employeeId}`                 | Archive (soft-delete) an employee. |
| `GET`    | `/personnel/employees/{employeeId}/personal-data`   | Get only the personal data section. |
| `PUT`    | `/personnel/employees/{employeeId}/personal-data`   | Update only the personal data section. |
| `GET`    | `/personnel/employees/{employeeId}/contact-info`    | Get only the contact info section. |
| `PUT`    | `/personnel/employees/{employeeId}/contact-info`    | Update only the contact info section. |
| `GET`    | `/personnel/employees/{employeeId}/contract-details`| Get only the contract details section. |
| `PUT`    | `/personnel/employees/{employeeId}/contract-details`| Update only the contract details section. |

---

## 🛡️ Security Principles
-   **Authentication:** All API Gateway endpoints are protected by the **Cognito User Pool authorizer**. Unauthenticated requests will be rejected with a `401 Unauthorized` error.
-   **Authorization:** (Future) Role-based access can be implemented by adding users to Cognito Groups and inspecting the token's claims.
-   **Least Privilege:** Each Lambda function has a unique IAM Role with the minimum necessary permissions to perform its specific task (e.g., `dynamodb:GetItem` or `dynamodb:UpdateItem`).
-   **Data Encryption:** All PII is encrypted at rest using AES-256 with a key managed via environment variables.
-   **Input Validation:** All endpoints validate incoming request bodies to prevent malformed or malicious payloads.

---

## 🔀 Git Workflow
-   **Main Branch:** `main` (should always be stable and deployable).
-   **Development Branch:** `dev`.
-   **Feature Branches:** Create branches from `dev` for new features (e.g., `feature/add-performance-reviews`).
-   **Process:**
    1.  `git checkout dev`
    2.  `git pull`
    3.  `git checkout -b feature/your-feature-name`
    4.  Make your changes, commit frequently.
    5.  `git push origin feature/your-feature-name`
    6.  Open a Pull Request on GitHub to merge your feature branch into `dev`.
    7.  Require at least one code review before merging.

---

## ⁉️ Troubleshooting
-   **`502 Bad Gateway` Error:** This usually means your Lambda function crashed on startup. The most common cause is a missing `require` statement or a bundling issue with shared utility files. Check the function's CloudWatch logs for a `ReferenceError` or `cannot find module` error.
-   **`USER_PASSWORD_AUTH flow not enabled`:** You forgot to add the `authFlows` configuration to the `UserPoolClient` in the CDK stack. See `hr-cdk-stack-stack.js`.
-   **`401 Unauthorized`:** Your `Authorization` header is missing, malformed, or the token is expired. Re-authenticate using the AWS CLI to get a fresh token.

---

## 🎓 Intern Onboarding Notes
-   **Start Here:** Read this `README.md` file completely. It's your primary source of truth.
-   **Understand the Architecture:**
    1.  Start with `lib/hr-cdk-stack-stack.js` to see how the AWS resources are defined and connected.
    2.  Explore the `lambda/` directory to understand the business logic. `createEmployee.js` and `getEmployee.js` are great starting points.
-   **Review the API Contracts:** Check the Postman Collection documentation for detailed request/response examples for each endpoint.
-   **Ask Questions:** Don't hesitate to ask questions. Use code comments (`// TODO: ...` or `// QUESTION: ...`), commit messages, and Pull Request descriptions to communicate clearly with your team.
-   **Key Resources:**
    -   [AWS CDK v2 Documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
    -   [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-nodejs.html)
    -   [Postman Collection Documentation](https://lanceandreibu.postman.co/workspace/LanceAndreiBU's-Workspace~81ba89d6-a5b2-4f8d-80a1-d276696e2628/collection/45856915-5206bfcc-94b9-4737-8dc7-b62053c730ba?action=share&source=copy-link&creator=45856915)