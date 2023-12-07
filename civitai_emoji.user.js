// ==UserScript==
// @name         Civitai Emoji
// @author       You
// @version      0.1
// @match        https://civitai.com/*
// @description  Civitai Emoji
// @icon         https://civitai.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // Simulates clicking on the emoji button.
    function pressEmojiButton(button) {
        //console.log('Attempting to click emoji button:', button);
        button.click();
    }

    // Identifies the emoji buttons within a post.
    function getEmojiButtonsInPost(postElement) {
        console.log('Getting emoji buttons within post element:', postElement);
        // Assume any button within this container could be an emoji button
        return postElement.querySelectorAll('button');
    }

    // Checks if the emojis have already been pressed by looking at their style.
    function isEmojiPressed(button) {
        const style = window.getComputedStyle(button);
        // Check the background color and text color to determine if the emoji is pressed
        // You might need to adjust the color values to match exactly what your site uses
        //console.log('style.backgroundColor:', style.backgroundColor);
        return !style.backgroundColor.includes('rgba(0, 0, 0, 0)');
    }

    let lastKnownX = 0;
    let lastKnownY = 0;

    document.addEventListener('mousemove', (event) => {
        lastKnownX = event.clientX;
        lastKnownY = event.clientY;
    });

    // This function finds the button that meets the criteria
    function findNextImageButton(carousel) {
        const buttons = Array.from(carousel.querySelectorAll('.mantine-Carousel-control'));
        return buttons.find(button => {
            const svg = button.querySelector('svg');
            // Check if svg exists and has the expected width and height
            if (svg && svg.getAttribute('width') === '16' && svg.getAttribute('height') === '16') {
                // Look for the rotation in the style string
                return svg.style.transform.includes('rotate(-90deg)');
            }
            return false;
        });
    }

    // This function clicks the button found by `findNextImageButton`
    function clickNextImageButton(button) {
        button.click();
    }

    function automateEmojiClicking() {

        //let element = document.querySelector(':hover');
        const elements = document.elementsFromPoint(lastKnownX, lastKnownY);
        let element = elements[0]; // Start with the top-most element
        let element_previous = null;
        let is_found_last = false;

        // Navigate up the DOM tree to find a parent element that seems like a container for the image and emoji buttons
        while (element && !element.classList.contains('mantine-Carousel-root')) {
            if (!is_found_last){
                if (!element.classList.contains('mantine-Paper-root')){
                    element_previous = element;
                }else{
                    is_found_last = true;
                }
            }
            element = element.parentElement;
        }

        let carousel = element;
        //console.log('carousel:', carousel);
        // Step 1: Find the parent element with the class "mantine-Carousel-container".
        //const carousel = element.querySelector('.mantine-Carousel-container');
        if (!carousel) {
            if (is_found_last){
                carousel = element_previous;
            }else{
                console.log('Carousel container not found.');
                return;
            }
        }

        const next_button = findNextImageButton(carousel);
        if (!next_button) {
            console.log('Next image button not found.');
            //return;
        }


        // Step 2: Save the URL of the first IMG tag to detect when we've looped through all images.
        const firstImageUrl = carousel.querySelector('img').src;
        console.log('firstImageUrl', firstImageUrl);

        // Helper function to click the right arrow key.
        function pressRightArrowKey() {
            /*const rightArrowEvent = new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, keyCode: 39
            });*/
            //console.log('rightArrowEvent Before.');
            //document.dispatchEvent(rightArrowEvent);
            if (next_button){
                clickNextImageButton(next_button);
            }
            //console.log('rightArrowEvent After.');
        }

        // Helper function to wait for a specified number of milliseconds.
        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Helper function to check and click on the emoji buttons.
        async function checkAndClickEmojis(currentImageUrl) {
            // Check for the presence of the emoji buttons and click them.
            const emojiButtons = carousel.querySelectorAll('button[type="button"]');
            emojiButtons.forEach(button => {

                const buttonText = button.textContent || button.innerText; // Get the text inside the button
                if (buttonText.includes('👍') || buttonText.includes('❤️')) {
                    // console.log('button');
                // Implement your own logic to determine if an emoji has been pressed
                    if (!isEmojiPressed(button)) {
                        pressEmojiButton(button);
                    }
                }
            });



            //console.log('wait Before.');
            // Wait for 0.2 seconds.
            await sleep(300);
            //console.log('wait After.');

            // Click the right arrow to go to the next image.
            pressRightArrowKey();
            const imageElements = carousel.querySelectorAll('img');
            let newImageUrl;
            if (imageElements.length === 1) {
                // If there's only one image, use its URL
                newImageUrl = imageElements[0].src;
            } else if (imageElements.length > 1) {
                console.log('imageElements.length:', imageElements.length);
                // If there are two or more images, use the URL of the second one
                newImageUrl = imageElements[0].src;
            } else {
                // No images found, handle accordingly
                console.log('No images found in the carousel.');
                return;
            }

            console.log('New img - new src', newImageUrl);
            if (newImageUrl !== firstImageUrl) {
                //console.log('New img - not same');
                await checkAndClickEmojis(newImageUrl); // Continue the loop if it's a new image.
            }else{
                console.log('Detected old image.');
            }
            //console.log('New img - After');
        }

        // Start the loop with the first image URL.
        checkAndClickEmojis(firstImageUrl);
    }

    // Event listener for the 'S' key with Ctrl and Shift held down.
    window.addEventListener('keydown', (event) => {
        if (event.key === 'S' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
            console.log('Ctrl + Shift + S key pressed, checking for emojis to press...');
            //checkAndPressEmojisUnderCursor();
            automateEmojiClicking();
        }
    });

    console.log('Emoji auto-press script initialized.');

})();
