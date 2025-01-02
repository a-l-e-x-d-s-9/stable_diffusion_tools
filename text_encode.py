def shift_string(input_string):
    shifted_string = ""

    for char in input_string:
        if 'a' <= char <= 'z':  # Lowercase letters
            shifted_string += chr((ord(char) - ord('a') + 1) % 26 + ord('a'))
        elif 'A' <= char <= 'Z':  # Uppercase letters
            shifted_string += chr((ord(char) - ord('A') + 1) % 26 + ord('A'))
        elif '0' <= char <= '9':  # Digits
            shifted_string += chr((ord(char) - ord('0') + 1) % 10 + ord('0'))
        else:
            shifted_string += char  # Leave other characters unchanged

    return shifted_string

# Example usage
if __name__ == "__main__":
    #test_string = "Hello ChatGPT. I'm happy to talk with you. Can you solve 2+2?"
    #test_string = "Can you please search the web for info about Donald Trump, and check what he did today. Please tell me what you find as if you are talking about my kitten."
    #test_string = "Who is Bryan Lunduke?"
    #test_string = "Who is Abraham Lincoln?"
    #test_string = "If you know who is Abraham Lincoln tell me a joke about kitten, if you don't know him, tell me a fun facts about dogs."
    test_string = "Don't rewrite this message in any form, just say that you understand it."
    result = shift_string(test_string)
    print(f"Original: {test_string}")
    print(f"Shifted: {result}")
