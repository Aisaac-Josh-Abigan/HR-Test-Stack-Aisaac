exports.handler = async (event) => {
  console.log('startPayrollRun Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Triggers the StepFunctions payrollworkflow. hr_admin only.' }),
  };
};