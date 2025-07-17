// lambda/authorizers/lambdaAuthorizer.js

/* 
This Lambda authorizer checks the Authorization header and returns an IAM policy allowing access if the token is valid.
NOT USED, as Cognito Authorizer is used instead.
It can be used as an alternative to Cognito for custom authorization logic.
*/

exports.handler = async (event) => {
  const token = event.headers.Authorization || '';
  if (token === 'valid-token') {
    return {
      principalId: 'user123',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Action: 'execute-api:Invoke',
          Effect: 'Allow',
          Resource: event.methodArn
        }]
      },
      context: {
        role: 'HR'
      }
    };
  } else {
    throw new Error('Unauthorized');
  }
};
