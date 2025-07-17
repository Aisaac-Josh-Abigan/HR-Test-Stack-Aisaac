exports.handler = async (event) => {
  console.log('listPayslips Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Lists payslups (All Roles, with ownership rules).' }),
  };
};