exports.handler = async (event) => {
  console.log('getEmployeeList Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'workflow steps get employee list.' }),
  };
};