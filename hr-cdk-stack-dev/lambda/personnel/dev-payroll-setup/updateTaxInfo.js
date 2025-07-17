exports.handler = async (event) => {
  console.log('updateTaxInfo mLambda Invoked:', event);
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Sets up tax details. hr_admin only.' }),
  };
};