const fs = require('fs');
const pdf = require('pdf-parse');

const dataBuffer = fs.readFileSync('web-v3/k15_manual.pdf');
pdf(dataBuffer).then(function(data) {
    fs.writeFileSync('web-v3/k15_manual.txt', data.text);
    console.log('Text extracted to web-v3/k15_manual.txt');
}).catch(function(error) {
    console.error('Error extracting text:', error);
});
