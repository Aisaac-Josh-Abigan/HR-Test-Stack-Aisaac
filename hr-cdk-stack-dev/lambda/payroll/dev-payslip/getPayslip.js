exports.handler = async (event) => {
  console.log('getPayslip Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Retrieves a single payslip (All Roles, with ownership rules).' }),
  };
};