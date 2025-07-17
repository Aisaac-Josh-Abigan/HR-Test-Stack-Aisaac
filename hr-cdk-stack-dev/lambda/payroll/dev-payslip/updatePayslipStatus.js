exports.handler = async (event) => {
  console.log('updatePayslipStatus Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Approves or rejects a payslip. manager_admin only.' }),
  };
};