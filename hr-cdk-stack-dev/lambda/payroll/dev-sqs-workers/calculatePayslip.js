exports.handler = async (event) => {
  console.log('calculatePayslip Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'workflow steps calculate payslip.' }),
  };
};