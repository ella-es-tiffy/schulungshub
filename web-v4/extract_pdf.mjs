import pdf from 'pdf-parse';
import fs from 'fs';

const dataBuffer = fs.readFileSync('web-v3/k15_manual.pdf');

try {
    const data = await pdf(dataBuffer);
    fs.writeFileSync('web-v3/k15_manual.txt', data.text);
    console.log('Text extracted to web-v3/k15_manual.txt');
} catch (error) {
    console.error('Error extracting text:', error);
}
