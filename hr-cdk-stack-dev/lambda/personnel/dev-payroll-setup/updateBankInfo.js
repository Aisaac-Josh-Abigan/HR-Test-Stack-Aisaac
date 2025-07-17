exports.handler = async (event) => {
  console.log('updateBankInfo Lambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Sets up bank details. hr_admin only.' }),
  };
};